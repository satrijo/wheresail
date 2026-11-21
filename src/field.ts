// Bilinear sampling over a gridded field (see api.ts GridData).

import type { GridData } from './api';

export type FieldVar =
  | 'windU'
  | 'windV'
  | 'windSpeed'
  | 'temperature'
  | 'precipitation'
  | 'waveHeight'
  | 'waveDirection'
  | 'wavePeriod';

export class GridField {
  constructor(public readonly data: GridData) {}

  get rows(): number {
    return this.data.rows;
  }
  get cols(): number {
    return this.data.cols;
  }
  get hours(): number {
    return this.data.hours;
  }
  get times(): string[] {
    return this.data.times;
  }
  get lats(): number[] {
    return this.data.lats;
  }
  get lons(): number[] {
    return this.data.lons;
  }

  /** Value at a grid node. NaN when missing. */
  node(variable: FieldVar, r: number, c: number, hour: number): number {
    const o = (hour * this.data.rows + r) * this.data.cols + c;
    return this.data[variable][o];
  }

  /**
   * Bilinear interpolation at (lat, lon, hour). Corners with no data are
   * excluded and the remaining weights renormalised; NaN if all four are
   * missing (e.g. marine variables over land).
   */
  sample(variable: FieldVar, lat: number, lon: number, hour: number): number {
    const { lats, lons } = this.data;
    const h = Math.max(0, Math.min(this.data.hours - 1, Math.round(hour)));

    // Bracketing column (lon) and row (lat); clamp to the grid edges.
    let c0 = 0;
    while (c0 < lons.length - 2 && lons[c0 + 1] <= lon) c0++;
    let r0 = 0;
    while (r0 < lats.length - 2 && lats[r0 + 1] <= lat) r0++;

    const fx =
      lons[c0 + 1] === lons[c0] ? 0 : (lon - lons[c0]) / (lons[c0 + 1] - lons[c0]);
    const fy =
      lats[r0 + 1] === lats[r0] ? 0 : (lat - lats[r0]) / (lats[r0 + 1] - lats[r0]);
    const tx = Math.max(0, Math.min(1, fx));
    const ty = Math.max(0, Math.min(1, fy));

    const corners: [number, number, number][] = [
      [r0, c0, (1 - tx) * (1 - ty)],
      [r0, c0 + 1, tx * (1 - ty)],
      [r0 + 1, c0, (1 - tx) * ty],
      [r0 + 1, c0 + 1, tx * ty],
    ];

    let sum = 0;
    let wsum = 0;
    for (const [r, c, w] of corners) {
      const v = this.node(variable, r, c, h);
      if (!Number.isNaN(v)) {
        sum += v * w;
        wsum += w;
      }
    }
    return wsum === 0 ? NaN : sum / wsum;
  }

  /** Wind vector (u/v in knots, towards east/north) at a point. Null if no data. */
  windVector(
    lat: number,
    lon: number,
    hour: number,
  ): { u: number; v: number; speed: number } | null {
    const u = this.sample('windU', lat, lon, hour);
    const v = this.sample('windV', lat, lon, hour);
    if (Number.isNaN(u) || Number.isNaN(v)) return null;
    return { u, v, speed: Math.hypot(u, v) };
  }
}
