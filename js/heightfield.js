// Terrain height lookup from scene/heightfield.json
// {"origin":[x,z],"step":s,"cols":c,"rows":r,"z_offset":o,"data":[row-major heights]}
// three.js coordinates: x/z on the ground, height y = data + z_offset. Rows advance along +z.

export class Heightfield {
  constructor(json) {
    this.ok = false;
    if (!json || !Array.isArray(json.data) || !json.cols || !json.rows) return;
    if (!Array.isArray(json.origin) || json.origin.length < 2 || !(json.step > 0)) return;
    this.ox = json.origin[0];
    this.oz = json.origin[1];
    this.step = json.step;
    this.cols = json.cols;
    this.rows = json.rows;
    this.off = json.z_offset || 0;
    this.data = json.data;
    this.ok = this.data.length >= this.cols * this.rows;
    // a 2×2 grid is the flat placeholder written before the terrain exists
    this.isPlaceholder = !!json.note || (this.cols <= 2 && this.rows <= 2);
  }

  /** bilinear height at (x, z); clamps to the grid edge; null when there is no grid */
  sample(x, z) {
    if (!this.ok) return null;
    let fx = (x - this.ox) / this.step;
    let fz = (z - this.oz) / this.step;
    fx = Math.min(Math.max(fx, 0), this.cols - 1.000001);
    fz = Math.min(Math.max(fz, 0), this.rows - 1.000001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const d = this.data, c = this.cols;
    const i1 = Math.min(i + 1, c - 1), j1 = Math.min(j + 1, this.rows - 1);
    const h00 = d[j * c + i], h10 = d[j * c + i1], h01 = d[j1 * c + i], h11 = d[j1 * c + i1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz + this.off;
  }
}
