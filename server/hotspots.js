// Predictive hotspots. Learns from the local history of reports:
// where problems repeat, how recently, and how often "fixed" issues come back.
// This is a statistical risk model you can later swap for a trained ML model.
const { db } = require('./db');
const { CATEGORIES } = require('./config');

const CELL = 0.005; // ~550 m grid
const WET = new Set(['pothole', 'water_leak', 'fallen_tree', 'road_damage']);

async function computeHotspots(limit = 8) {
  const rows = await db.all(`
    SELECT r.created_at, r.lat, r.lng, i.id AS issue_id, i.category, i.status
    FROM reports r JOIN issues i ON i.id = r.issue_id`);
  const reopenedIssues = new Set((await db.all("SELECT DISTINCT issue_id FROM events WHERE `type` IN ('reopened','verification_incomplete')")).map((r) => r.issue_id));

  const cells = new Map();
  const now = Date.now();
  for (const r of rows) {
    const key = Math.floor(r.lat / CELL) + ',' + Math.floor(r.lng / CELL);
    if (!cells.has(key)) cells.set(key, { reports: 0, recent: 0, issues: new Map(), latSum: 0, lngSum: 0 });
    const c = cells.get(key);
    c.reports++; c.latSum += r.lat; c.lngSum += r.lng;
    if (now - new Date(r.created_at).getTime() <= 30 * 86400000) c.recent++;
    if (!c.issues.has(r.issue_id)) c.issues.set(r.issue_id, r.category);
  }

  const month = new Date().getMonth(); // monsoon-ish months (Jul-Sep) raise risk for wet-weather damage
  const monsoon = month >= 6 && month <= 8;
  const out = [];
  for (const [, c] of cells) {
    const byCat = {};
    for (const cat of c.issues.values()) byCat[cat] = (byCat[cat] || 0) + 1;
    const repeat = Object.values(byCat).reduce((s, n) => s + Math.max(0, n - 1), 0);
    const reopened = [...c.issues.keys()].filter((id) => reopenedIssues.has(id)).length;
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    let raw = c.recent * 3 + (c.reports - c.recent) + repeat * 4 + reopened * 6;
    if (monsoon && WET.has(top[0])) raw *= 1.2;
    if (raw < 4) continue;
    const score = Math.min(99, Math.round(100 * (1 - Math.exp(-raw / 70))));
    const label = CATEGORIES[top[0]].label.toLowerCase();
    let rec = `${c.issues.size} separate ${c.issues.size === 1 ? 'issue' : 'issues'} and ${c.reports} reports in this area, mostly ${label}. `;
    if (repeat > 0) rec += `The same type of problem keeps coming back here. `;
    if (reopened > 0) rec += `${reopened} earlier ${reopened === 1 ? 'repair was' : 'repairs were'} reopened. `;
    if (WET.has(top[0])) rec += 'Wet weather makes this worse: inspect the surface and drainage before the next heavy rain.';
    else rec += 'Preventive inspection recommended.';
    out.push({
      lat: c.latSum / c.reports, lng: c.lngSum / c.reports, score,
      level: score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 40 ? 'medium' : 'low',
      reports: c.reports, issues: c.issues.size, recent_30d: c.recent, repeats: repeat,
      top_category: top[0], top_category_label: CATEGORIES[top[0]].label, recommendation: rec.trim()
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { computeHotspots };
