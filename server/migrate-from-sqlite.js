// ONE-TIME helper: copies everything from your old SQLite file (data/civicai.db) into MySQL.
// Usage:  npm run migrate:sqlite                 (uses data/civicai.db)
//         npm run migrate:sqlite -- path/to/old.db
// Needs Node 22.13+ only for this script (it reads the old SQLite file). The app itself runs on Node 18+.
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { db, init, close, deptByCode } = require('./db');

const file = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'civicai.db'));
const toDate = (v) => (v ? new Date(v) : null);

async function main() {
  if (!fs.existsSync(file)) throw new Error(`Old SQLite file not found: ${file}`);
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (_) { throw new Error('This script needs Node 22.13 or newer (it reads the old SQLite file). Install the current Node LTS, run it once, then you can go back.'); }
  const old = new DatabaseSync(file, { readOnly: true });

  await init();
  if ((await db.count('SELECT COUNT(*) n FROM issues')) > 0 && !process.argv.includes('--force')) {
    throw new Error('MySQL already contains issues. Run "npm run reset" first (wipes MySQL) or add --force to copy anyway.');
  }

  const oldDept = Object.fromEntries(old.prepare('SELECT id, code FROM departments').all().map((d) => [d.id, d.code]));
  const landmarks = old.prepare('SELECT * FROM landmarks').all();
  const issues = old.prepare('SELECT * FROM issues ORDER BY id').all();
  const reports = old.prepare('SELECT * FROM reports ORDER BY id').all();
  const events = old.prepare('SELECT * FROM events ORDER BY id').all();

  await db.tx(async (t) => {
    for (const l of landmarks) {
      await t.run('INSERT INTO landmarks (id, name, `type`, lat, lng, radius_m) VALUES (?,?,?,?,?,?)', [l.id, l.name, l.type, l.lat, l.lng, l.radius_m]);
    }
    for (const i of issues) {
      const dept = deptByCode[oldDept[i.department_id]];
      await t.run(`INSERT INTO issues (id, category, status, severity, severity_level, severity_reason, hazard, lat, lng, context, department_id,
        report_count, first_reported_at, last_reported_at, resolved_at, verification_status, verification_note, cover_photo, after_photo, ai_summary, assignee)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [i.id, i.category, i.status, i.severity, i.severity_level, i.severity_reason, i.hazard, i.lat, i.lng, i.context, dept ? dept.id : null,
          i.report_count, toDate(i.first_reported_at), toDate(i.last_reported_at), toDate(i.resolved_at), i.verification_status,
          i.verification_note, i.cover_photo, i.after_photo, i.ai_summary, i.assignee]);
    }
    for (const r of reports) {
      await t.run(`INSERT INTO reports (id, tracking_id, issue_id, photo, photo_hash, description, lat, lng, reporter_name, contact, ai_json, merge_note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.id, r.tracking_id, r.issue_id, r.photo, r.photo_hash, r.description, r.lat, r.lng, r.reporter_name, r.contact, r.ai_json, r.merge_note, toDate(r.created_at)]);
    }
    for (const e of events) {
      await t.run('INSERT INTO events (id, issue_id, `type`, note, actor, created_at) VALUES (?,?,?,?,?,?)', [e.id, e.issue_id, e.type, e.note, e.actor, toDate(e.created_at)]);
    }
  });
  old.close();
  console.log(`Copied ${landmarks.length} landmarks, ${issues.length} issues, ${reports.length} reports, ${events.length} events into MySQL.`);
  console.log('Your uploads/ folder is unchanged and keeps working. You can now archive data/civicai.db.');
}

main().catch((err) => { console.error('\nMigration failed: ' + err.message + '\n'); process.exitCode = 1; }).finally(close);
