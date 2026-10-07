// Core business logic: submit report -> AI -> context -> duplicate merge -> route -> track -> verify.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, deptByCode, deptById, addEvent } = require('./db');
const { CATEGORIES, DUP_RADIUS_M, DUP_VISUAL_RADIUS_M, DUP_VISUAL_SIMILARITY } = require('./config');
const { haversine, contextFor } = require('./geo');
const { computeSeverity } = require('./scoring');
const ai = require('./ai');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function saveImage(buffer, ext) {
  const name = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return name;
}

function readImage(name) {
  if (!name) return null;
  const p = path.join(UPLOAD_DIR, path.basename(name));
  if (!fs.existsSync(p)) return null;
  const mime = p.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { buffer: fs.readFileSync(p), mime };
}

async function newTrackingId() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = 'CV-';
    for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    if (!(await db.get('SELECT 1 AS x FROM reports WHERE tracking_id = ?', [s]))) return s;
  }
}

// Departments are loaded once at startup (deptById), so this stays synchronous.
function serializeIssue(row) {
  if (!row) return null;
  const cat = CATEGORIES[row.category] || CATEGORIES.other;
  const dept = deptById[row.department_id];
  return {
    id: row.id, category: row.category, category_label: cat.label, icon: cat.icon,
    status: row.status, severity: row.severity, severity_level: row.severity_level,
    severity_reason: row.severity_reason, lat: row.lat, lng: row.lng,
    context: row.context ? JSON.parse(row.context) : {},
    department: dept ? dept.name : null, department_code: dept ? dept.code : null,
    report_count: row.report_count, first_reported_at: row.first_reported_at,
    last_reported_at: row.last_reported_at, resolved_at: row.resolved_at,
    verification_status: row.verification_status, verification_note: row.verification_note,
    cover_photo: row.cover_photo ? '/uploads/' + row.cover_photo : null,
    after_photo: row.after_photo ? '/uploads/' + row.after_photo : null,
    ai_summary: row.ai_summary, assignee: row.assignee
  };
}

async function getIssue(id, exec = db) {
  return serializeIssue(await exec.get('SELECT * FROM issues WHERE id = ?', [id]));
}

async function findDuplicate(exec, { category, lat, lng, hash }) {
  const box = 0.0012; // ~130 m search box
  const candidates = await exec.all(
    `SELECT * FROM issues WHERE category = ? AND status != 'verified'
     AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
    [category, lat - box, lat + box, lng - box, lng + box]);

  let best = null;
  for (const c of candidates) {
    const d = haversine(lat, lng, c.lat, c.lng);
    let reason = null, similarity = null;
    if (d <= DUP_RADIUS_M) {
      reason = `same type within ${Math.round(d)} m`;
    } else if (d <= DUP_VISUAL_RADIUS_M && hash) {
      const first = await exec.get('SELECT photo_hash FROM reports WHERE issue_id = ? AND photo_hash IS NOT NULL ORDER BY id LIMIT 1', [c.id]);
      similarity = ai.hashSimilarity(hash, first && first.photo_hash);
      if (similarity >= DUP_VISUAL_SIMILARITY) reason = `photo ${Math.round(similarity * 100)}% similar, ${Math.round(d)} m away`;
    }
    if (reason && (!best || d < best.d)) best = { issue: c, d, reason };
  }
  return best;
}

// Only one report is merged/inserted at a time (in this Node process), so two people reporting the same
// pothole at the same moment cannot both create a new issue. (SQLite used to guarantee this by being synchronous.)
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function submitReport({ file, lat, lng, description, name, contact, userCategory }) {
  const img = await ai.normalizeImage(file.buffer, file.mimetype);
  const hash = await ai.imageHash(img.buffer);
  const analysis = await ai.analyzeImage({ buffer: img.buffer, mime: img.mime, description, userCategory });
  const photoName = saveImage(img.buffer, img.ext);
  const now = new Date();
  const tracking = await newTrackingId();

  const { issueRow, merged, mergeNote, reopened } = await exclusive(() => db.tx(async (t) => {
    const dup = await findDuplicate(t, { category: analysis.category, lat, lng, hash });
    let issueRow, merged = false, mergeNote = null, reopened = false;

    if (dup) {
      merged = true;
      mergeNote = dup.reason;
      const cur = dup.issue;
      const count = cur.report_count + 1;
      const hazard = Math.max(cur.hazard, analysis.hazard);
      const sev = computeSeverity({
        category: cur.category, hazard, context: JSON.parse(cur.context || '{}'),
        reportCount: count, firstReportedAt: cur.first_reported_at
      });
      let status = cur.status;
      if (cur.status === 'resolved') { status = 'reopened'; reopened = true; }
      await t.run(`UPDATE issues SET report_count=?, hazard=?, severity=?, severity_level=?, severity_reason=?,
                  last_reported_at=?, status=?, resolved_at=CASE WHEN ?='reopened' THEN NULL ELSE resolved_at END,
                  verification_status=CASE WHEN ?='reopened' THEN 'incomplete' ELSE verification_status END
                  WHERE id=?`,
        [count, hazard, sev.score, sev.level, sev.reason, now, status, status, status, cur.id]);
      await addEvent(cur.id, 'duplicate_merged', `Report #${count} merged automatically (${dup.reason}). Severity now ${sev.score}/100.`, 'system', t);
      if (reopened) await addEvent(cur.id, 'reopened', 'A new citizen report arrived after this was marked resolved.', 'system', t);
      issueRow = await t.get('SELECT * FROM issues WHERE id = ?', [cur.id]);
    } else {
      const context = await contextFor(lat, lng, t);
      const sev = computeSeverity({ category: analysis.category, hazard: analysis.hazard, context, reportCount: 1 });
      const dept = deptByCode[(CATEGORIES[analysis.category] || CATEGORIES.other).dept];
      const r = await t.run(`INSERT INTO issues (category, status, severity, severity_level, severity_reason, hazard, lat, lng,
          context, department_id, report_count, first_reported_at, last_reported_at, cover_photo, ai_summary)
          VALUES (?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [analysis.category, sev.score, sev.level, sev.reason, analysis.hazard, lat, lng,
          JSON.stringify(context), dept.id, now, now, photoName, analysis.summary]);
      await addEvent(r.insertId, 'created',
        `Report received. AI identified: ${CATEGORIES[analysis.category].label} (${analysis.mode === 'vision' ? 'photo analysis' : 'manual category'}).`, 'system', t);
      await addEvent(r.insertId, 'routed', `Automatically routed to ${dept.name}. Severity ${sev.score}/100 (${sev.reason}).`, 'system', t);
      issueRow = await t.get('SELECT * FROM issues WHERE id = ?', [r.insertId]);
    }

    await t.run(`INSERT INTO reports (tracking_id, issue_id, photo, photo_hash, description, lat, lng, reporter_name, contact, ai_json, merge_note, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tracking, issueRow.id, photoName, hash, description || null, lat, lng, name || null, contact || null,
        JSON.stringify(analysis), mergeNote, now]);
    return { issueRow, merged, mergeNote, reopened };
  }));

  return {
    tracking_id: tracking, merged, merge_note: mergeNote, reopened,
    ai: { mode: analysis.mode, confidence: analysis.confidence, summary: analysis.summary },
    issue: serializeIssue(issueRow)
  };
}

async function trackReport(trackingId) {
  const rep = await db.get('SELECT * FROM reports WHERE tracking_id = ?', [String(trackingId).toUpperCase().trim()]);
  if (!rep) return null;
  const issue = await getIssue(rep.issue_id);
  const events = await db.all('SELECT `type`, note, actor, created_at FROM events WHERE issue_id = ? ORDER BY id', [rep.issue_id]);
  return {
    tracking_id: rep.tracking_id, submitted_at: rep.created_at, merge_note: rep.merge_note,
    your_photo: rep.photo ? '/uploads/' + rep.photo : null, issue, events
  };
}

// Compare the original photo with a new "after" photo and update the issue.
async function verifyFix({ issueId, file, actor }) {
  const issue = await db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
  if (!issue) throw Object.assign(new Error('Issue not found'), { status: 404 });
  const img = await ai.normalizeImage(file.buffer, file.mimetype);
  const afterName = saveImage(img.buffer, img.ext);
  const before = readImage(issue.cover_photo);
  const result = before
    ? await ai.compareBeforeAfter({ before, after: img, category: issue.category })
    : { verdict: 'needs_review', note: 'No original photo on file. Staff will review.' };

  let status = issue.status;
  const verification = result.verdict;
  if (verification === 'verified') status = 'verified';
  else if (verification === 'incomplete') status = 'reopened';
  else if (['submitted', 'assigned', 'in_progress'].includes(issue.status)) status = 'resolved';

  await db.run(`UPDATE issues SET after_photo=?, verification_status=?, verification_note=?, status=?,
              resolved_at=CASE WHEN ? IN ('resolved','verified') THEN COALESCE(resolved_at, ?) ELSE NULL END WHERE id=?`,
    [afterName, verification, result.note || null, status, status, new Date(), issueId]);

  const label = { verified: 'Fix verified by AI', incomplete: 'Possible incomplete resolution', needs_review: 'After photo needs staff review' }[verification];
  await addEvent(issueId, 'verification_' + verification, `${label}. ${result.note || ''}`.trim(), actor);
  return { ...result, issue: await getIssue(issueId) };
}

module.exports = { submitReport, trackReport, verifyFix, serializeIssue, getIssue, saveImage, readImage };
