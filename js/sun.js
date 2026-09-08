// Simple solar position model (no three.js dependency).
// Returns the unit direction TOWARDS the sun in three.js world space (x east-ish, y up, z south-ish),
// rotated so that compass north lies along `northDeg` (degrees CCW from +X in the Blender X/Y plane,
// i.e. three.js north = (cos nd, 0, -sin nd)). See SPEC.md §1/§2.

const DEG = Math.PI / 180;

export function solarAngles(hour, lat = 34.7, dayOfYear = 166) {
  // Declination (Cooper), hour angle from local solar noon; equation of time ignored on purpose.
  const decl = 23.45 * DEG * Math.sin((360 / 365) * (284 + dayOfYear) * DEG);
  const H = (hour - 12) * 15 * DEG;
  const la = lat * DEG;
  const sinEl = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const cosAz = (Math.sin(decl) - sinEl * Math.sin(la)) / (Math.cos(el) * Math.cos(la) || 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))); // from north, clockwise
  if (H > 0) az = 2 * Math.PI - az;
  return { elevation: el, azimuth: az };
}

export function sunDirection(hour, northDeg = 112, lat = 34.7, dayOfYear = 166, out = { x: 0, y: 0, z: 0 }) {
  const { elevation, azimuth } = solarAngles(hour, lat, dayOfYear);
  const nd = northDeg * DEG;
  // north and east unit vectors on the three.js ground plane (x, z)
  const nx = Math.cos(nd), nz = -Math.sin(nd);
  const ex = Math.sin(nd), ez = Math.cos(nd); // east = north rotated 90° clockwise seen from above
  const h = Math.cos(elevation);
  const cN = Math.cos(azimuth) * h, cE = Math.sin(azimuth) * h;
  out.x = cN * nx + cE * ex;
  out.z = cN * nz + cE * ez;
  out.y = Math.sin(elevation);
  out.elevation = elevation;
  out.azimuth = azimuth;
  return out;
}

export function formatHour(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
}
