// Side-panel rendering: 48-hour point forecast (stats, sparklines, hourly table).

import type { PointData } from './api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseUtc(iso: string): Date {
  return new Date(iso + 'Z');
}

function fmtDayHour(iso: string): string {
  const d = parseUtc(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
}

export function compassLabel(deg: number | null): string {
  if (deg === null || Number.isNaN(deg)) return '—';
  const dirs = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
  ];
  return dirs[Math.round(deg / 22.5) % 16];
}

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(digits);
}

function sparkline(values: (number | null)[], color: string): string {
  const w = 300;
  const h = 52;
  const pad = 4;
  const valid = values.filter((v): v is number => v !== null && !Number.isNaN(v));
  if (valid.length < 2) return '<p class="spark-label">No data for this chart.</p>';
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const vv = v === null || Number.isNaN(v) ? min : v;
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = h - pad - ((vv - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" /></svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderForecastPanel(
  el: HTMLElement,
  data: PointData,
  lat: number,
  lon: number,
  hourIndex: number,
): void {
  const h = Math.max(0, Math.min(data.times.length - 1, hourIndex));
  const latStr = `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
  const wind = data.windSpeed[h];
  const dir = data.windDirection[h];
  const wave = data.waveHeight[h];
  const period = data.wavePeriod[h];
  const sst = data.seaTemperature[h];
  const temp = data.temperature[h];
  const rain = data.precipitation[h];

  const rows = data.times
    .map((t, i) => {
      const w = data.windSpeed[i];
      const d = data.windDirection[i];
      const wv = data.waveHeight[i];
      const tp = data.temperature[i];
      const rn = data.precipitation[i];
      return `<tr class="${i === h ? 'selected' : ''}" data-hour="${i}">
        <td>${esc(fmtDayHour(t))}</td>
        <td>${fmtNum(w, 0)}${w !== null ? ` ${compassLabel(d)}` : ''}</td>
        <td>${fmtNum(wv)}</td>
        <td>${fmtNum(tp, 0)}</td>
        <td>${fmtNum(rn)}</td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <h2>Point forecast</h2>
    <p class="panel-sub">${latStr}, ${lonStr} · times in UTC · GFS + ICON via Open-Meteo</p>
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Wind</div>
        <div class="stat-value">${fmtNum(wind, 0)} kn</div>
        <div class="stat-extra">${dir !== null && dir !== undefined ? `${Math.round(dir)}° ${compassLabel(dir)}` : '—'}</div></div>
      <div class="stat"><div class="stat-label">Waves</div>
        <div class="stat-value">${fmtNum(wave)} m</div>
        <div class="stat-extra">${period !== null ? `${fmtNum(period, 0)} s period` : '—'}</div></div>
      <div class="stat"><div class="stat-label">Sea temp</div>
        <div class="stat-value">${fmtNum(sst)} °C</div>
        <div class="stat-extra">surface</div></div>
      <div class="stat"><div class="stat-label">Air temp</div>
        <div class="stat-value">${fmtNum(temp, 0)} °C</div>
        <div class="stat-extra">rain ${fmtNum(rain)} mm</div></div>
    </div>
    <h3>Wind — next 48 h</h3>
    ${sparkline(data.windSpeed, '#0b6fa4')}
    <p class="spark-label">Wind speed, knots. Range ${fmtNum(Math.min(...data.windSpeed.filter((v): v is number => v !== null)), 0)}–${fmtNum(Math.max(...data.windSpeed.filter((v): v is number => v !== null)), 0)} kn.</p>
    <h3>Waves — next 48 h</h3>
    ${sparkline(data.waveHeight, '#0e7490')}
    <p class="spark-label">Significant wave height, metres.</p>
    <h3>Hourly — 48 h</h3>
    <div class="table-scroll">
      <table class="hourly-table">
        <thead><tr><th>Time (UTC)</th><th>Wind</th><th>Wave m</th><th>°C</th><th>Rain mm</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
