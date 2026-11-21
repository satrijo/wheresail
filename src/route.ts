// Route planner: waypoints, per-leg weather at the leg midpoint for the
// selected forecast hour, and ETA from a configurable boat speed.

import type { GridField } from './field';

export interface Waypoint {
  lat: number;
  lon: number;
}

export interface LegInfo {
  index: number;
  distanceNm: number;
  etaHours: number;
  windKn: number | null;
  windDirDeg: number | null;
  waveM: number | null;
}

const EARTH_RADIUS_NM = 3440.065;

export function haversineNm(a: Waypoint, b: Waypoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

export function computeLegs(
  points: Waypoint[],
  field: GridField | null,
  hour: number,
  boatSpeedKn: number,
): { legs: LegInfo[]; totalNm: number; totalHours: number } {
  const legs: LegInfo[] = [];
  let totalNm = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const distanceNm = haversineNm(a, b);
    const midLat = (a.lat + b.lat) / 2;
    const midLon = (a.lon + b.lon) / 2;
    let windKn: number | null = null;
    let windDirDeg: number | null = null;
    let waveM: number | null = null;
    if (field) {
      const w = field.windVector(midLat, midLon, hour);
      if (w) {
        windKn = w.speed;
        windDirDeg = (Math.atan2(-w.u, -w.v) * (180 / Math.PI) + 360) % 360;
      }
      const wh = field.sample('waveHeight', midLat, midLon, hour);
      if (!Number.isNaN(wh)) waveM = wh;
    }
    totalNm += distanceNm;
    legs.push({
      index: i,
      distanceNm,
      etaHours: distanceNm / boatSpeedKn,
      windKn,
      windDirDeg,
      waveM,
    });
  }
  return { legs, totalNm, totalHours: totalNm / boatSpeedKn };
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min === 0 ? `${whole} h` : `${whole} h ${min} min`;
}

function compass16(deg: number): string {
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

export function renderRoutePanel(
  el: HTMLElement,
  points: Waypoint[],
  legs: LegInfo[],
  totalNm: number,
  totalHours: number,
  boatSpeedKn: number,
): void {
  if (points.length === 0) {
    el.innerHTML = `
      <h2>Route planner</h2>
      <p class="route-empty">Route mode is on. Click the map to drop waypoints —
      each leg shows distance, mid-leg wind and waves for the selected
      forecast hour, and the sailing time at your boat speed.
      Click a numbered waypoint to remove it.</p>`;
    return;
  }
  if (points.length === 1) {
    el.innerHTML = `
      <h2>Route planner</h2>
      <p class="route-empty">Waypoint 1 set. Click the map again to add the next
      waypoint — a leg is drawn between each pair.</p>`;
    return;
  }
  const legHtml = legs
    .map(
      (l) => `
      <div class="leg">
        <div class="leg-title">Leg ${l.index + 1} → ${l.index + 2}</div>
        <div class="leg-detail">
          ${l.distanceNm.toFixed(1)} nm · ${fmtHours(l.etaHours)} at ${boatSpeedKn.toFixed(1)} kn<br>
          Mid-leg: wind ${
            l.windKn !== null
              ? `${l.windKn.toFixed(0)} kn ${l.windDirDeg !== null ? compass16(l.windDirDeg) : ''}`
              : '—'
          } · waves ${l.waveM !== null ? `${l.waveM.toFixed(1)} m` : '—'}
        </div>
      </div>`,
    )
    .join('');
  el.innerHTML = `
    <h2>Route planner</h2>
    <p class="panel-sub">${points.length} waypoints · weather at each leg midpoint for the selected forecast hour</p>
    ${legHtml}
    <div class="route-total">Total: ${totalNm.toFixed(1)} nm · ${fmtHours(totalHours)} at ${boatSpeedKn.toFixed(1)} kn</div>
    <div class="route-actions">
      <button class="btn" type="button" data-action="clear-route">Clear route</button>
    </div>`;
}
