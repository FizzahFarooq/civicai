require('dotenv').config({ quiet: true });
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const { db, init, close, addEvent } = require('./db');
const { CATEGORIES, ALL_STATUSES, OPEN_STATUSES, DONE_STATUSES } = require('./config');
const ai = require('./ai');
const { submitReport, trackReport, verifyFix, serializeIssue, getIssue } = require('./issues');
const { computeHotspots } = require('./hotspots');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const CENTER = {
  lat: Number(process.env.MAP_CENTER_LAT) || 33.6844,
  lng: Number(process.env.MAP_CENTER_LNG) || 73.0479
};

app.disable('x-powered-by');
app.set('trust proxy', false);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '100kb' }));

// ---------- static files ----------
const root = path.join(__dirname, '..');
app.use('/vendor/leaflet', express.static(path.join(root, 'node_modules/leaflet/dist')));
app.use('/vendor/fonts', express.static(path.join(root, 'node_modules/@fontsource')));
app.use('/uploads', express.static(path.join(root, 'uploads'), { maxAge: '7d', index: false }));
app.use(express.static(path.join(root, 'public')));

// ---------- helpers ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Please upload a JPG, PNG or WebP photo.'), { status: 400 }))
});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    hits.push(now); buckets.set(key, hits);
    next();
  };
}

// ---------- admin auth (in-memory sessions) ----------
const sessions = new Map();
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Please sign in again.' });
  req.admin = s.user;
  next();
}

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({
    center: CENTER, ai_mode: ai.mode(),
    categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, icon: c.icon }))
  });
});

app.get('/api/public/stats', wrap(async (req, res) => {
  const open = OPEN_STATUSES.map(() => '?').join(',');
  const done = DONE_STATUSES.map(() => '?').join(',');
  const totalReports = await db.count('SELECT COUNT(*) n FROM reports');
  const issues = await db.count('SELECT COUNT(*) n FROM issues');
  res.json({
    reports: totalReports,
    merged: Math.max(0, totalReports - issues),
    resolved: await db.count(`SELECT COUNT(*) n FROM issues WHERE status IN (${done})`, DONE_STATUSES),
    verified: await db.count(`SELECT COUNT(*) n FROM issues WHERE status = 'verified'`),
    open: await db.count(`SELECT COUNT(*) n FROM issues WHERE status IN (${open})`, OPEN_STATUSES)
  });
}));

app.post('/api/reports', rateLimit('report', 20, 60 * 60 * 1000), upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Add a photo of the problem.' });
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Choose the problem location on the map.' });
  }
  const clean = (v, n) => (v ? String(v).trim().slice(0, n) : null);
  const result = await submitReport({
    file: req.file, lat, lng,
    description: clean(req.body.description, 500),
    name: clean(req.body.name, 80), contact: clean(req.body.contact, 80),
    userCategory: CATEGORIES[req.body.category] ? req.body.category : null
  });
  res.status(201).json(result);
}));

app.get('/api/track/:id', wrap(async (req, res) => {
  const t = await trackReport(req.params.id);
  if (!t) return res.status(404).json({ error: 'No report found with that tracking ID. Check the ID and try again.' });
  res.json(t);
}));

app.post('/api/track/:id/verify', rateLimit('verify', 20, 60 * 60 * 1000), upload.single('photo'), wrap(async (req, res) => {
  const t = await trackReport(req.params.id);
  if (!t) return res.status(404).json({ error: 'No report found with that tracking ID.' });
  if (!['resolved', 'verified'].includes(t.issue.status)) {
    return res.status(400).json({ error: 'This issue has not been marked as fixed yet.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Add a new photo of the location.' });
  res.json(await verifyFix({ issueId: t.issue.id, file: req.file, actor: 'citizen ' + t.tracking_id }));
}));

// ---------- admin API ----------
app.post('/api/admin/login', rateLimit('login', 10, 15 * 60 * 1000), (req, res) => {
  const { username, password } = req.body || {};
  if (!safeEqual(username || '', ADMIN_USER) || !safeEqual(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user: ADMIN_USER, expires: Date.now() + 8 * 3600 * 1000 });
  res.json({ token, user: ADMIN_USER });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
  res.json({ ok: true });
});

app.get('/api/admin/summary', requireAdmin, wrap(async (req, res) => {
  const open = OPEN_STATUSES.map(() => '?').join(',');
  const done = DONE_STATUSES.map(() => '?').join(',');
  const byLevel = {};
  for (const r of await db.all(`SELECT severity_level l, COUNT(*) n FROM issues WHERE status IN (${open}) GROUP BY severity_level`, OPEN_STATUSES)) byLevel[r.l] = r.n;
  const byDept = await db.all(`SELECT d.name, COUNT(*) n FROM issues i JOIN departments d ON d.id = i.department_id
                               WHERE i.status IN (${open}) GROUP BY d.name ORDER BY n DESC`, OPEN_STATUSES);
  const reports = await db.count('SELECT COUNT(*) n FROM reports');
  res.json({
    critical: await db.count(`SELECT COUNT(*) n FROM issues WHERE status IN (${open}) AND severity_level = 'critical'`, OPEN_STATUSES),
    unresolved: await db.count(`SELECT COUNT(*) n FROM issues WHERE status IN (${open})`, OPEN_STATUSES),
    resolved: await db.count(`SELECT COUNT(*) n FROM issues WHERE status IN (${done})`, DONE_STATUSES),
    needs_review: await db.count(`SELECT COUNT(*) n FROM issues WHERE verification_status IN ('needs_review','incomplete')`),
    total_reports: reports,
    duplicates_merged: Math.max(0, reports - await db.count('SELECT COUNT(*) n FROM issues')),
    by_level: byLevel, by_department: byDept
  });
}));

app.get('/api/admin/priorities', requireAdmin, wrap(async (req, res) => {
  const open = OPEN_STATUSES.map(() => '?').join(',');
  const rows = await db.all(`SELECT * FROM issues WHERE status IN (${open}) ORDER BY severity DESC, report_count DESC LIMIT 5`, OPEN_STATUSES);
  res.json(rows.map(serializeIssue));
}));

app.get('/api/admin/issues', requireAdmin, wrap(async (req, res) => {
  const where = [], params = [];
  const { status, level, category, group } = req.query;
  if (group === 'open') { where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
  else if (group === 'done') { where.push(`status IN (${DONE_STATUSES.map(() => '?').join(',')})`); params.push(...DONE_STATUSES); }
  if (ALL_STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (['critical', 'high', 'medium', 'low'].includes(level)) { where.push('severity_level = ?'); params.push(level); }
  if (CATEGORIES[category]) { where.push('category = ?'); params.push(category); }
  const sql = `SELECT * FROM issues ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY severity DESC, last_reported_at DESC LIMIT 500`;
  res.json((await db.all(sql, params)).map(serializeIssue));
}));

app.get('/api/admin/issues/:id', requireAdmin, wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM issues WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Issue not found.' });
  const reports = (await db.all(`SELECT tracking_id, photo, description, reporter_name, contact, merge_note, created_at
                                 FROM reports WHERE issue_id = ? ORDER BY id`, [row.id]))
    .map((r) => ({ ...r, photo: r.photo ? '/uploads/' + r.photo : null }));
  const events = await db.all('SELECT `type`, note, actor, created_at FROM events WHERE issue_id = ? ORDER BY id', [row.id]);
  res.json({ issue: serializeIssue(row), reports, events });
}));

app.patch('/api/admin/issues/:id', requireAdmin, wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM issues WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Issue not found.' });
  const { status, note, assignee } = req.body || {};
  const now = new Date();
  if (status !== undefined) {
    if (!ALL_STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status.' });
    await db.run(`UPDATE issues SET status = ?, resolved_at = CASE WHEN ? IN ('resolved','verified') THEN COALESCE(resolved_at, ?) ELSE NULL END,
                verification_status = CASE WHEN ? = 'resolved' AND verification_status IN ('none','incomplete') THEN 'pending'
                                           WHEN ? = 'verified' THEN 'verified' ELSE verification_status END WHERE id = ?`,
      [status, status, now, status, status, row.id]);
    if (status !== row.status) await addEvent(row.id, 'status_' + status, `Status changed to ${status.replace('_', ' ')}.${note ? ' ' + note : ''}`, req.admin);
    else if (note) await addEvent(row.id, 'note', note, req.admin);
  } else if (note) await addEvent(row.id, 'note', String(note).slice(0, 500), req.admin);
  if (assignee !== undefined) {
    await db.run('UPDATE issues SET assignee = ? WHERE id = ?', [String(assignee).slice(0, 80) || null, row.id]);
    if (assignee) await addEvent(row.id, 'assigned', `Assigned to ${String(assignee).slice(0, 80)}.`, req.admin);
  }
  res.json(await getIssue(row.id));
}));

// Staff mark an issue resolved, optionally with an "after" photo that the AI checks immediately.
app.post('/api/admin/issues/:id/resolve', requireAdmin, upload.single('photo'), wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM issues WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Issue not found.' });
  await db.run(`UPDATE issues SET status = 'resolved', resolved_at = ?, verification_status = 'pending' WHERE id = ?`, [new Date(), row.id]);
  await addEvent(row.id, 'status_resolved', 'Marked as repaired by the department. Waiting for verification.', req.admin);
  if (req.file) return res.json(await verifyFix({ issueId: row.id, file: req.file, actor: req.admin }));
  res.json({ verdict: 'pending', issue: await getIssue(row.id) });
}));

app.get('/api/admin/hotspots', requireAdmin, wrap(async (req, res) => res.json(await computeHotspots())));

app.get('/api/admin/landmarks', requireAdmin, wrap(async (req, res) => res.json(await db.all('SELECT * FROM landmarks ORDER BY `type`, name'))));
app.post('/api/admin/landmarks', requireAdmin, wrap(async (req, res) => {
  const { name, type, lat, lng, radius_m } = req.body || {};
  if (!name || !['main_road', 'school', 'hospital', 'market'].includes(type) || !Number.isFinite(+lat) || !Number.isFinite(+lng)) {
    return res.status(400).json({ error: 'Provide name, type (main_road/school/hospital/market), lat and lng.' });
  }
  const r = await db.run('INSERT INTO landmarks (name, `type`, lat, lng, radius_m) VALUES (?,?,?,?,?)',
    [String(name).slice(0, 100), type, +lat, +lng, Math.min(2000, Math.max(30, +radius_m || 200))]);
  res.status(201).json({ id: r.insertId });
}));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || (err instanceof multer.MulterError ? 400 : 500);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is larger than 10 MB. Choose a smaller one.' : status === 500 ? 'Something went wrong on our side. Please try again.' : err.message;
  if (status === 500) console.error(err);
  res.status(status).json({ error: msg });
});

init().then((cfg) => {
  const server = app.listen(PORT, () => {
    console.log(`\n  CivicAI is running  ->  http://localhost:${PORT}`);
    console.log(`  Authority dashboard ->  http://localhost:${PORT}/#/dashboard   (user: ${ADMIN_USER})`);
    console.log(`  AI mode: ${ai.mode() === 'vision' ? 'VISION (photo analysis on)' : 'MANUAL (no ANTHROPIC_API_KEY set)'}`);
    if (ADMIN_PASSWORD === 'change-me-now') console.log('  WARNING: change ADMIN_PASSWORD in your .env file.');
    console.log(`  Database: MySQL  ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}\n`);
  });
  const shutdown = () => { server.close(() => close().finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch((err) => {
  console.error('\n  CivicAI could not start:\n  ' + err.message + '\n');
  process.exit(1);
});
