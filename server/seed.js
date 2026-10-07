// Fills the MySQL database with demo landmarks + realistic demo issues so the dashboard is not empty.
// Usage:  npm run seed        (adds demo data)
//         npm run reset       (wipes everything first, then adds demo data)
require('dotenv').config({ quiet: true });
const { db, init, close, deptByCode, addEvent } = require('./db');
const { CATEGORIES } = require('./config');
const { contextFor } = require('./geo');
const { computeSeverity } = require('./scoring');

const C = { lat: Number(process.env.MAP_CENTER_LAT) || 33.6844, lng: Number(process.env.MAP_CENTER_LNG) || 73.0479 };
const off = (dLat, dLng) => ({ lat: C.lat + dLat, lng: C.lng + dLng });

// [category, dLat, dLng, hazard, reports, ageDays, status]
const demo = [
  ['pothole', 0.0001, 0.0021, 5, 37, 4, 'in_progress'],
  ['pothole', 0.0003, -0.0035, 4, 9, 6, 'submitted'],
  ['pothole', 0.0006, -0.0034, 3, 4, 9, 'resolved'],
  ['pothole', -0.0032, 0.0062, 3, 6, 3, 'assigned'],
  ['water_leak', 0.0042, 0.0010, 4, 12, 3, 'submitted'],
  ['water_leak', -0.0058, -0.0028, 3, 2, 8, 'resolved'],
  ['streetlight', 0.0001, -0.0003, 3, 5, 5, 'assigned'],
  ['streetlight', 0.0033, -0.0072, 2, 1, 2, 'submitted'],
  ['garbage', -0.0030, 0.0058, 3, 8, 7, 'in_progress'],
  ['garbage', -0.0040, 0.0063, 2, 3, 15, 'verified'],
  ['fallen_tree', 0.0035, 0.0058, 5, 3, 1, 'submitted'],
  ['traffic_sign', 0.0002, 0.0041, 3, 2, 10, 'submitted'],
  ['road_damage', -0.0059, -0.0031, 4, 3, 5, 'submitted'],
  ['footpath', -0.0031, 0.0059, 2, 1, 4, 'submitted'],
  ['pothole', 0.0012, 0.0100, 2, 1, 1, 'submitted'],
  ['water_leak', 0.0080, -0.0080, 2, 1, 20, 'verified'],
  ['pothole', 0.0004, -0.0036, 3, 2, 40, 'verified'],
  ['pothole', 0.0005, -0.0033, 3, 2, 22, 'verified']
];

async function main() {
  await init();

  if (process.argv.includes('--reset')) {
    for (const t of ['events', 'reports', 'issues', 'landmarks']) {
      await db.run(`DELETE FROM ${t}`);
      await db.run(`ALTER TABLE ${t} AUTO_INCREMENT = 1`);
    }
    console.log('Database cleared.');
  }

  if ((await db.count('SELECT COUNT(*) n FROM landmarks')) === 0) {
    const lm = [
      ['Demo Main Boulevard (east)', 'main_road', off(0.000, 0.004), 220],
      ['Demo Main Boulevard (centre)', 'main_road', off(0.000, 0.000), 220],
      ['Demo Main Boulevard (west)', 'main_road', off(0.000, -0.004), 220],
      ['Demo Public School', 'school', off(0.0045, 0.0012), 300],
      ['Demo Girls High School', 'school', off(-0.006, -0.003), 300],
      ['Demo District Hospital', 'hospital', off(0.003, -0.007), 300],
      ['Demo Central Market', 'market', off(-0.003, 0.006), 250]
    ];
    for (const [n, t, p, r] of lm) {
      await db.run('INSERT INTO landmarks (name, `type`, lat, lng, radius_m) VALUES (?,?,?,?,?)', [n, t, p.lat, p.lng, r]);
    }
    console.log(`Added ${lm.length} demo landmarks. Replace them with real places for your city (see README).`);
  }

  // Tracking IDs for demo reports continue after the existing number of reports, so seeding twice never collides.
  let n = await db.count('SELECT COUNT(*) n FROM reports');
  await db.tx(async (t) => {
    for (const [cat, dLat, dLng, hazard, count, age, status] of demo) {
      const p = off(dLat, dLng);
      const context = await contextFor(p.lat, p.lng, t);
      const first = new Date(Date.now() - age * 86400000);
      const sev = computeSeverity({ category: cat, hazard, context, reportCount: count, firstReportedAt: first });
      const done = ['resolved', 'verified'].includes(status);
      const r = await t.run(`INSERT INTO issues (category, status, severity, severity_level, severity_reason, hazard, lat, lng, context,
        department_id, report_count, first_reported_at, last_reported_at, resolved_at, verification_status, ai_summary)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cat, status, sev.score, sev.level, sev.reason, hazard, p.lat, p.lng, JSON.stringify(context),
          deptByCode[CATEGORIES[cat].dept].id, count, first, new Date(), done ? new Date() : null,
          status === 'verified' ? 'verified' : status === 'resolved' ? 'pending' : 'none', CATEGORIES[cat].label + ' (demo data)']);
      const id = r.insertId;
      await addEvent(id, 'created', `Report received. AI identified: ${CATEGORIES[cat].label}.`, 'system', t);
      await addEvent(id, 'routed', `Automatically routed to ${CATEGORIES[cat].dept}. Severity ${sev.score}/100 (${sev.reason}).`, 'system', t);
      if (count > 1) await addEvent(id, 'duplicate_merged', `${count - 1} more citizen reports merged automatically.`, 'system', t);
      if (status !== 'submitted') await addEvent(id, 'status_' + status, `Status changed to ${status.replace('_', ' ')}.`, 'admin', t);
      for (let i = 0; i < count; i++) {
        n++;
        const when = new Date(Date.now() - (age * 86400000) * (1 - i / Math.max(count, 1)));
        await t.run('INSERT INTO reports (tracking_id, issue_id, description, lat, lng, ai_json, created_at) VALUES (?,?,?,?,?,?,?)',
          ['CV-D' + String(n).padStart(5, '0'), id, 'Demo report', p.lat, p.lng, '{"mode":"demo"}', when]);
      }
    }
  });
  console.log(`Added ${demo.length} demo issues. Open the dashboard to see them.`);
}

main().catch((err) => { console.error('\nSeed failed: ' + err.message + '\n'); process.exitCode = 1; }).finally(close);
