// Geospatial helpers: distance + "what is around this point?"
const { db } = require('./db');

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Reads the landmarks table and describes the surroundings of a point.
async function contextFor(lat, lng, exec = db) {
  const ctx = { road_type: 'local_street', schools: [], hospitals: [], markets: [], roads: [] };
  const rows = await exec.all('SELECT * FROM landmarks');
  for (const l of rows) {
    const d = haversine(lat, lng, l.lat, l.lng);
    if (d > l.radius_m) continue;
    const item = { name: l.name, distance_m: Math.round(d) };
    if (l.type === 'main_road') ctx.roads.push(item);
    if (l.type === 'school') ctx.schools.push(item);
    if (l.type === 'hospital') ctx.hospitals.push(item);
    if (l.type === 'market') ctx.markets.push(item);
  }
  if (ctx.roads.length) ctx.road_type = 'main_road';
  else if (ctx.markets.length) ctx.road_type = 'busy_market';
  for (const k of ['schools', 'hospitals', 'markets', 'roads']) ctx[k].sort((a, b) => a.distance_m - b.distance_m);
  return ctx;
}

module.exports = { haversine, contextFor };
