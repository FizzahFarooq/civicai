// Central place for categories, departments and scoring weights.
// Edit this file to adapt CivicAI to your city.

const CATEGORIES = {
  pothole:      { label: 'Pothole',               icon: '🕳️', base: 40, dept: 'ROADS' },
  streetlight:  { label: 'Broken streetlight',    icon: '💡', base: 30, dept: 'LIGHTING' },
  road_damage:  { label: 'Damaged road / barrier', icon: '🚧', base: 40, dept: 'ROADS' },
  footpath:     { label: 'Blocked footpath',      icon: '🚶', base: 28, dept: 'MUNICIPAL' },
  garbage:      { label: 'Garbage accumulation',  icon: '🗑️', base: 25, dept: 'MUNICIPAL' },
  water_leak:   { label: 'Water leakage',         icon: '🚰', base: 38, dept: 'WATER' },
  traffic_sign: { label: 'Damaged traffic sign',  icon: '🛑', base: 35, dept: 'TRAFFIC' },
  fallen_tree:  { label: 'Fallen tree',           icon: '🌳', base: 45, dept: 'MUNICIPAL' },
  other:        { label: 'Other civic issue',     icon: '📍', base: 20, dept: 'MUNICIPAL' }
};

const DEPARTMENTS = [
  { code: 'ROADS',     name: 'Road Maintenance Department' },
  { code: 'LIGHTING',  name: 'Municipal Lighting Department' },
  { code: 'WATER',     name: 'Water & Sanitation Agency (WASA)' },
  { code: 'TRAFFIC',   name: 'Traffic Authority' },
  { code: 'MUNICIPAL', name: 'Municipal Corporation (Sanitation & Parks)' }
];

// Statuses
const OPEN_STATUSES = ['submitted', 'assigned', 'in_progress', 'reopened'];
const DONE_STATUSES = ['resolved', 'verified'];
const ALL_STATUSES = [...OPEN_STATUSES, ...DONE_STATUSES];

// Duplicate detection
const DUP_RADIUS_M = 40;        // same category within 40 m = same issue
const DUP_VISUAL_RADIUS_M = 100; // within 100 m AND photos look alike = same issue
const DUP_VISUAL_SIMILARITY = 0.8;

module.exports = {
  CATEGORIES, DEPARTMENTS, OPEN_STATUSES, DONE_STATUSES, ALL_STATUSES,
  DUP_RADIUS_M, DUP_VISUAL_RADIUS_M, DUP_VISUAL_SIMILARITY
};
