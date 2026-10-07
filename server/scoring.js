// Transparent severity scoring (0-100). Every point can be explained.
// Combines: what the photo shows + road type + nearby schools/hospitals
//           + how many citizens reported it + how long it has been open.
const { CATEGORIES } = require('./config');

const HAZARD_FACTOR = [0.6, 0.8, 1.0, 1.25, 1.5]; // AI hazard level 1..5

function levelFor(score) {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function computeSeverity({ category, hazard = 3, context = {}, reportCount = 1, firstReportedAt }) {
  const cat = CATEGORIES[category] || CATEGORIES.other;
  const h = Math.min(5, Math.max(1, Math.round(hazard)));
  const reasons = [];

  const sizeWord = ['Minor', 'Small', 'Moderate', 'Large', 'Severe'][h - 1];
  let score = Math.min(60, Math.round(cat.base * HAZARD_FACTOR[h - 1]));
  reasons.push(`${sizeWord} ${cat.label.toLowerCase()}`);

  if (context.road_type === 'main_road') { score += 15; reasons.push('main road'); }
  else if (context.road_type === 'busy_market') { score += 8; reasons.push('busy market area'); }

  if (context.schools && context.schools.length) {
    score += 12; reasons.push(`school ${context.schools[0].distance_m} m away`);
  }
  if (context.hospitals && context.hospitals.length) {
    score += 6; reasons.push(`hospital ${context.hospitals[0].distance_m} m away`);
  }

  if (reportCount > 1) {
    score += Math.min(15, Math.round((reportCount - 1) * 1.5));
    reasons.push(`${reportCount} citizen reports`);
  }

  if (firstReportedAt) {
    const days = (Date.now() - new Date(firstReportedAt).getTime()) / 86400000;
    if (days >= 2) {
      score += Math.min(8, Math.floor(days / 2));
      reasons.push(`open for ${Math.floor(days)} days`);
    }
  }

  score = Math.max(1, Math.min(100, score));
  return { score, level: levelFor(score), reason: reasons.join(' + ') };
}

module.exports = { computeSeverity, levelFor };
