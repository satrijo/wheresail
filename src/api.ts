// Open-Meteo data access — Forecast API + Marine API.
// Both are free and need no API key. Free tier: 10,000 requests/day per IP
// (shared across all callers behind one egress IP, so treat 429 as normal
// and surface it in the UI instead of crashing).
// Docs: https://open-meteo.com/en/docs

export interface PointData {
  times: string[]; // ISO 8601, UTC
  windSpeed: (number | null)[]; // knots
  windDirection: (number | null)[]; // degrees, direction the wind comes FROM
  temperature: (number | null)[]; // °C
  precipitation: (number | null)[]; // mm
  waveHeight: (number | null)[]; // m
  waveDirection: (number | null)[]; // degrees
  wavePeriod: (number | null)[]; // s
  swellHeight: (number | null)[]; // m
  seaTemperature: (number | null)[]; // °C
}

/** Gridded field: one value per (hour, row, col). Missing values are NaN. */
export interface GridData {
  times: string[];
  lats: number[]; // ascending
  lons: number[]; // ascending
  rows: number;
  cols: number;
  hours: number;
  windU: Float32Array; // knots, u component (towards east)
  windV: Float32Array; // knots, v component (towards north)
  windSpeed: Float32Array; // knots
  temperature: Float32Array; // °C
  precipitation: Float32Array; // mm
  waveHeight: Float32Array; // m
  waveDirection: Float32Array; // degrees
  wavePeriod: Float32Array; // s
}

export class OpenMeteoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

const FORECAST_VARS = 'wind_speed_10m,wind_direction_10m,temperature_2m,precipitation';
const MARINE_VARS =
  'wave_height,wave_direction,wave_period,swell_wave_height,wind_wave_height,ocean_current_velocity,sea_surface_temperature';

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      if (res.status === 429) {
        throw new OpenMeteoError(
          429,
          'Open-Meteo daily request limit reached for this network (free tier: 10,000/day per IP). Data will resume after the limit resets.',
        );
      }
      throw new OpenMeteoError(res.status, `Open-Meteo request failed (HTTP ${res.status}).`);
    }
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof OpenMeteoError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Open-Meteo request timed out. Check your connection and retry.');
    }
    throw new Error('Could not reach Open-Meteo. Check your connection and retry.');
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo returns an object for one location, an array for several. */
function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

type NumArray = (number | null)[];

function hourlyNumbers(item: Record<string, unknown>, key: string): NumArray {
  const hourly = item.hourly as Record<string, unknown> | undefined;
  const arr = hourly?.[key];
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => (typeof v === 'number' ? v : null));
}

/** Wind (speed kn, direction-from deg) -> u/v components (towards east/north). */
function toUV(speed: number | null, dir: number | null): { u: number; v: number } {
  if (speed === null || dir === null) return { u: NaN, v: NaN };
  const rad = (dir * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

/** Fetch one point (forecast + marine in parallel) with the full 48h horizon. */
export async function fetchPoint(lat: number, lon: number): Promise<PointData> {
  const key = `point|${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = pointCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const fUrl =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${FORECAST_VARS}&wind_speed_unit=kn&forecast_days=2&timezone=UTC`;
  const mUrl =
    `${MARINE_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=${MARINE_VARS}&forecast_days=2&timezone=UTC`;

  const [fRaw, mRaw] = await Promise.all([fetchJson(fUrl), fetchJson(mUrl)]);
  const f = asArray(fRaw as Record<string, unknown>[])[0] as Record<string, unknown>;
  const m = asArray(mRaw as Record<string, unknown>[])[0] as Record<string, unknown>;

  const times = hourlyNumbers(f, 'time').length
    ? ((f.hourly as Record<string, unknown>).time as string[])
    : [];
  const data: PointData = {
    times,
    windSpeed: hourlyNumbers(f, 'wind_speed_10m'),
    windDirection: hourlyNumbers(f, 'wind_direction_10m'),
    temperature: hourlyNumbers(f, 'temperature_2m'),
    precipitation: hourlyNumbers(f, 'precipitation'),
    waveHeight: hourlyNumbers(m, 'wave_height'),
    waveDirection: hourlyNumbers(m, 'wave_direction'),
    wavePeriod: hourlyNumbers(m, 'wave_period'),
    swellHeight: hourlyNumbers(m, 'swell_wave_height'),
    seaTemperature: hourlyNumbers(m, 'sea_surface_temperature'),
  };
  pointCache.set(key, { at: Date.now(), data });
  return data;
}

export interface GridRequest {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  stepDeg: number;
}

/**
 * Fetch a coarse grid over a bounding box in ONE request per API
 * (Open-Meteo accepts comma-separated latitude/longitude lists and
 * returns the locations in request order). Results are cached 10 min.
 */
export async function fetchGrid(req: GridRequest): Promise<GridData> {
  const key = `grid|${req.minLat.toFixed(2)},${req.maxLat.toFixed(2)},${req.minLon.toFixed(2)},${req.maxLon.toFixed(2)},${req.stepDeg}`;
  const cached = gridCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const lats: number[] = [];
  for (let la = req.minLat; la <= req.maxLat + 1e-9; la += req.stepDeg) {
    lats.push(Math.round(la * 1000) / 1000);
  }
  const lons: number[] = [];
  for (let lo = req.minLon; lo <= req.maxLon + 1e-9; lo += req.stepDeg) {
    lons.push(Math.round(lo * 1000) / 1000);
  }
  const rows = lats.length;
  const cols = lons.length;
  const n = rows * cols;

  // Request order: row-major (lat outer, lon inner); responses match it.
  const reqLats: number[] = [];
  const reqLons: number[] = [];
  for (const la of lats) {
    for (const lo of lons) {
      reqLats.push(la);
      reqLons.push(lo);
    }
  }

  const fUrl =
    `${FORECAST_URL}?latitude=${reqLats.join(',')}&longitude=${reqLons.join(',')}` +
    `&hourly=${FORECAST_VARS}&wind_speed_unit=kn&forecast_days=2&timezone=UTC`;
  const mUrl =
    `${MARINE_URL}?latitude=${reqLats.join(',')}&longitude=${reqLons.join(',')}` +
    `&hourly=${MARINE_VARS}&forecast_days=2&timezone=UTC`;

  const [fRaw, mRaw] = await Promise.all([fetchJson(fUrl), fetchJson(mUrl)]);
  const fItems = asArray(fRaw as Record<string, unknown>[]);
  const mItems = asArray(mRaw as Record<string, unknown>[]);

  if (fItems.length === 0) throw new Error('Open-Meteo returned no forecast data.');
  const firstHourly = fItems[0].hourly as Record<string, unknown>;
  const times = (firstHourly.time as string[]) ?? [];
  const hours = times.length;
  if (hours === 0) throw new Error('Open-Meteo returned an empty time axis.');

  const size = hours * rows * cols;
  const grid: GridData = {
    times,
    lats,
    lons,
    rows,
    cols,
    hours,
    windU: new Float32Array(size).fill(NaN),
    windV: new Float32Array(size).fill(NaN),
    windSpeed: new Float32Array(size).fill(NaN),
    temperature: new Float32Array(size).fill(NaN),
    precipitation: new Float32Array(size).fill(NaN),
    waveHeight: new Float32Array(size).fill(NaN),
    waveDirection: new Float32Array(size).fill(NaN),
    wavePeriod: new Float32Array(size).fill(NaN),
  };

  for (let i = 0; i < n; i++) {
    const f = fItems[i];
    const m = mItems[i];
    if (!f) continue;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const spd = hourlyNumbers(f, 'wind_speed_10m');
    const dir = hourlyNumbers(f, 'wind_direction_10m');
    const tmp = hourlyNumbers(f, 'temperature_2m');
    const prc = hourlyNumbers(f, 'precipitation');
    const wh = m ? hourlyNumbers(m, 'wave_height') : [];
    const wd = m ? hourlyNumbers(m, 'wave_direction') : [];
    const wp = m ? hourlyNumbers(m, 'wave_period') : [];
    for (let h = 0; h < hours; h++) {
      const o = (h * rows + r) * cols + c;
      const s = spd[h];
      const d = dir[h];
      const uv = toUV(s ?? null, d ?? null);
      grid.windU[o] = uv.u;
      grid.windV[o] = uv.v;
      grid.windSpeed[o] = s ?? NaN;
      grid.temperature[o] = tmp[h] ?? NaN;
      grid.precipitation[o] = prc[h] ?? NaN;
      grid.waveHeight[o] = wh[h] ?? NaN;
      grid.waveDirection[o] = wd[h] ?? NaN;
      grid.wavePeriod[o] = wp[h] ?? NaN;
    }
  }

  gridCache.set(key, { at: Date.now(), data: grid });
  return grid;
}

const gridCache = new Map<string, { at: number; data: GridData }>();
const pointCache = new Map<string, { at: number; data: PointData }>();
