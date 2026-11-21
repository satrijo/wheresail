// WhereSail — application wiring: map, data grid, particles, layers,
// timeline, forecast panel and route planner.

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { fetchGrid, fetchPoint, type PointData } from './api';
import { GridField } from './field';
import { ParticleField } from './particles';
import { LAYERS, legendGradient, renderLayer, type LayerId } from './overlay';
import { renderForecastPanel } from './panel';
import { computeLegs, renderRoutePanel, type Waypoint } from './route';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CARTO_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

/** Fallback if the Carto style is unreachable: plain OSM raster tiles. */
const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`Missing element #${id}`);
  return n as T;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

interface AppState {
  layer: LayerId;
  hourIndex: number;
  hours: number;
  times: string[];
  routeMode: boolean;
  boatSpeedKn: number;
  playing: boolean;
}

const state: AppState = {
  layer: 'wind',
  hourIndex: 0,
  hours: 48,
  times: [],
  routeMode: false,
  boatSpeedKn: 6,
  playing: false,
};

type PanelMode = 'forecast' | 'route' | null;

let map: maplibregl.Map;
let gridField: GridField | null = null;
let layerDirty = false;
let panelMode: PanelMode = null;
let forecastOpen: { lat: number; lon: number; data: PointData } | null = null;
let waypoints: Waypoint[] = [];
let routeMarkers: maplibregl.Marker[] = [];
let clickMarker: maplibregl.Marker | null = null;
let cssW = 0;
let cssH = 0;
let playTimer: number | undefined;
let gridTimer: number | undefined;
let gridSeq = 0;

// DOM handles (resolved in init, after the DOM exists — module runs deferred).
let layerCanvas: HTMLCanvasElement;
let layerCtx: CanvasRenderingContext2D;
let particleCanvas: HTMLCanvasElement;
let particles: ParticleField;
let panelContent: HTMLElement;

async function resolveStyle(): Promise<string | maplibregl.StyleSpecification> {
  try {
    const r = await fetch(CARTO_STYLE, { signal: AbortSignal.timeout(8000) });
    if (r.ok) return CARTO_STYLE;
  } catch {
    // Fall through to the OSM raster style.
  }
  return OSM_STYLE;
}

function gridStepForZoom(zoom: number): number {
  if (zoom >= 7) return 0.5;
  if (zoom >= 5) return 1;
  if (zoom >= 4) return 2;
  if (zoom >= 3) return 2.5;
  return 5;
}

type StatusKind = 'loading' | 'live' | 'error';

function setStatus(kind: StatusKind, text: string): void {
  const pill = el<HTMLButtonElement>('status-pill');
  pill.className = `status ${kind}`;
  pill.textContent = text;
  pill.title = kind === 'error' ? 'Data error — click to retry' : 'Data status';
}

function updateLegend(): void {
  const def = LAYERS[state.layer];
  el('legend-label').textContent = def.label;
  el('legend-gradient').style.background = legendGradient(state.layer);
  el('legend-min').textContent = `${def.min} ${def.unit}`;
  el('legend-max').textContent = `${def.max} ${def.unit}`;
}

function setLayer(layer: LayerId): void {
  state.layer = layer;
  document.querySelectorAll('.layer-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.layer === layer);
  });
  updateLegend();
  layerDirty = true;
}

function updateTimeLabel(): void {
  const iso = state.times[state.hourIndex];
  const label = el('time-label');
  if (!iso) {
    label.textContent = '—';
    return;
  }
  const d = new Date(iso + 'Z');
  const utc = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  const local = `${pad2(d.getHours())}:${pad2(d.getMinutes())} local`;
  label.textContent = `${utc} · ${local}`;
}

function initialHourIndex(): number {
  const now = Date.now();
  for (let i = 0; i < state.times.length; i++) {
    if (Date.parse(state.times[i] + 'Z') >= now - 3600_000) return i;
  }
  return 0;
}

function syncTimeline(): void {
  const slider = el<HTMLInputElement>('timeline');
  slider.max = String(state.hours - 1);
  slider.disabled = false;
  el<HTMLButtonElement>('play-btn').disabled = false;
  if (state.hourIndex >= state.hours) state.hourIndex = initialHourIndex();
  else if (state.times.length > 0 && state.hourIndex === 0 && slider.value === '0') {
    // First load: jump to the current hour.
    state.hourIndex = initialHourIndex();
  }
  slider.value = String(state.hourIndex);
  updateTimeLabel();
}

function onHourChanged(): void {
  const slider = el<HTMLInputElement>('timeline');
  slider.value = String(state.hourIndex);
  updateTimeLabel();
  layerDirty = true;
  refreshRoutePanel();
  if (panelMode === 'forecast' && forecastOpen) {
    const scroller = panelContent.querySelector('.table-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    renderForecastPanel(
      panelContent,
      forecastOpen.data,
      forecastOpen.lat,
      forecastOpen.lon,
      state.hourIndex,
    );
    const scroller2 = panelContent.querySelector('.table-scroll');
    if (scroller2) scroller2.scrollTop = top;
  }
}

function setPlaying(on: boolean): void {
  state.playing = on;
  el<HTMLButtonElement>('play-btn').textContent = on ? '❚❚' : '▶';
  if (on) {
    playTimer = window.setInterval(() => {
      state.hourIndex = (state.hourIndex + 1) % state.hours;
      onHourChanged();
    }, 1200);
  } else if (playTimer !== undefined) {
    clearInterval(playTimer);
    playTimer = undefined;
  }
}

function showPanel(): void {
  el('panel').classList.remove('hidden');
}

function hidePanel(): void {
  el('panel').classList.add('hidden');
  panelMode = null;
  forecastOpen = null;
  clickMarker?.remove();
  clickMarker = null;
}

async function refreshGrid(): Promise<void> {
  const mySeq = ++gridSeq;
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  let step = gridStepForZoom(zoom);
  const minLat = Math.max(-84, bounds.getSouth());
  const maxLat = Math.min(84, bounds.getNorth());
  let minLon = bounds.getWest();
  let maxLon = bounds.getEast();
  if (minLon > maxLon) {
    // Dateline crossing: keep the half holding the view centre.
    if (map.getCenter().lng >= 0) maxLon = 180;
    else minLon = -180;
  }
  // Cap the grid so one request stays small (<= ~400 points).
  while ((maxLat - minLat) / step + 1 > 0 && ((maxLat - minLat) / step + 1) * ((maxLon - minLon) / step + 1) > 400) {
    step *= 2;
  }
  setStatus('loading', 'Loading data…');
  try {
    const data = await fetchGrid({ minLat, maxLat, minLon, maxLon, stepDeg: step });
    if (mySeq !== gridSeq) return; // Superseded by a newer request.
    gridField = new GridField(data);
    state.times = data.times;
    state.hours = data.hours;
    syncTimeline();
    layerDirty = true;
    setStatus('live', 'Live data · Open-Meteo');
    refreshRoutePanel();
  } catch (err) {
    if (mySeq !== gridSeq) return;
    setStatus('error', err instanceof Error ? err.message : 'Data load failed — click to retry.');
  }
}

function scheduleGridRefresh(): void {
  if (gridTimer !== undefined) clearTimeout(gridTimer);
  gridTimer = window.setTimeout(() => void refreshGrid(), 500);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function makeClickMarkerEl(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'click-marker';
  return div;
}

async function openForecast(lat: number, lon: number): Promise<void> {
  panelMode = 'forecast';
  showPanel();
  panelContent.innerHTML = '<p class="route-empty">Loading 48-hour forecast…</p>';
  clickMarker?.remove();
  clickMarker = new maplibregl.Marker({ element: makeClickMarkerEl() })
    .setLngLat([lon, lat])
    .addTo(map);
  try {
    const data = await fetchPoint(round2(lat), round2(lon));
    forecastOpen = { lat, lon, data };
    renderForecastPanel(panelContent, data, lat, lon, state.hourIndex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load forecast.';
    panelContent.innerHTML = `<h2>Point forecast</h2><p class="route-empty">${msg}</p>`;
  }
}

function syncRouteMarkers(): void {
  routeMarkers.forEach((m) => m.remove());
  routeMarkers = waypoints.map((wp, i) => {
    const div = document.createElement('div');
    div.className = 'route-marker';
    div.textContent = String(i + 1);
    div.title = 'Click to remove this waypoint';
    div.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeWaypoint(i);
    });
    return new maplibregl.Marker({ element: div }).setLngLat([wp.lon, wp.lat]).addTo(map);
  });
}

function updateRouteLine(): void {
  const src = map.getSource('route-line') as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features:
      waypoints.length > 1
        ? [
            {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: waypoints.map((w) => [w.lon, w.lat]),
              },
              properties: {},
            },
          ]
        : [],
  });
}

function refreshRoutePanel(): void {
  if (panelMode !== 'route') return;
  const { legs, totalNm, totalHours } = computeLegs(
    waypoints,
    gridField,
    state.hourIndex,
    state.boatSpeedKn,
  );
  renderRoutePanel(panelContent, waypoints, legs, totalNm, totalHours, state.boatSpeedKn);
  panelContent
    .querySelector('[data-action="clear-route"]')
    ?.addEventListener('click', () => clearRoute());
}

function addWaypoint(wp: Waypoint): void {
  waypoints.push(wp);
  panelMode = 'route';
  showPanel();
  syncRouteMarkers();
  updateRouteLine();
  el<HTMLButtonElement>('clear-route').disabled = false;
  refreshRoutePanel();
}

function removeWaypoint(i: number): void {
  waypoints.splice(i, 1);
  syncRouteMarkers();
  updateRouteLine();
  if (waypoints.length === 0) el<HTMLButtonElement>('clear-route').disabled = true;
  refreshRoutePanel();
}

function clearRoute(): void {
  waypoints = [];
  syncRouteMarkers();
  updateRouteLine();
  el<HTMLButtonElement>('clear-route').disabled = true;
  refreshRoutePanel();
}

function setRouteMode(on: boolean): void {
  state.routeMode = on;
  el<HTMLButtonElement>('route-toggle').setAttribute('aria-pressed', String(on));
  if (on) {
    panelMode = 'route';
    showPanel();
    refreshRoutePanel();
  } else if (panelMode === 'route') {
    hidePanel();
  }
}

function sizeCanvases(): void {
  const wrap = el('map-wrap');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  for (const [canvas, ctx] of [
    [layerCanvas, layerCtx],
    [particleCanvas, particles ? (particleCanvas.getContext('2d') as CanvasRenderingContext2D) : null],
  ] as [HTMLCanvasElement, CanvasRenderingContext2D | null][]) {
    if (!ctx) continue;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  cssW = w;
  cssH = h;
  particles.resize(w, h, dpr);
  layerDirty = true;
}

function frame(): void {
  if (gridField) particles.step();
  if (layerDirty && gridField) {
    renderLayer(
      layerCtx,
      gridField,
      state.layer,
      state.hourIndex,
      (lat, lon) => {
        const p = map.project([lon, lat]);
        return { x: p.x, y: p.y };
      },
      cssW,
      cssH,
    );
    layerDirty = false;
  }
  requestAnimationFrame(frame);
}

async function init(): Promise<void> {
  layerCanvas = el<HTMLCanvasElement>('layer-canvas');
  particleCanvas = el<HTMLCanvasElement>('particle-canvas');
  panelContent = el('panel-content');
  const lctx = layerCanvas.getContext('2d');
  const pctx = particleCanvas.getContext('2d');
  if (!lctx || !pctx) throw new Error('Canvas 2D context unavailable.');
  layerCtx = lctx;

  const style = await resolveStyle();
  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [115, -5],
    zoom: 4,
    minZoom: 2,
    maxZoom: 12,
  });
  map.addControl(new maplibregl.NavigationControl(), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');

  particles = new ParticleField(particleCanvas, {
    project: (lat, lon) => {
      const p = map.project([lon, lat]);
      return { x: p.x, y: p.y };
    },
    unproject: (x, y) => {
      const ll = map.unproject([x, y]);
      return { lat: ll.lat, lon: ll.lng };
    },
    viewBounds: () => {
      const b = map.getBounds();
      return {
        minLat: b.getSouth(),
        maxLat: b.getNorth(),
        minLon: b.getWest(),
        maxLon: b.getEast(),
      };
    },
    sampleWind: (lat, lon) =>
      gridField ? gridField.windVector(lat, lon, state.hourIndex) : null,
    getZoom: () => map.getZoom(),
  });

  // UI wiring.
  document.querySelectorAll('.layer-btn').forEach((b) => {
    b.addEventListener('click', () => setLayer((b as HTMLButtonElement).dataset.layer as LayerId));
  });
  el<HTMLButtonElement>('route-toggle').addEventListener('click', () =>
    setRouteMode(!state.routeMode),
  );
  el<HTMLButtonElement>('clear-route').addEventListener('click', () => clearRoute());
  el<HTMLButtonElement>('status-pill').addEventListener('click', () => {
    if (el('status-pill').classList.contains('error')) void refreshGrid();
  });
  el<HTMLButtonElement>('panel-close').addEventListener('click', () => hidePanel());
  el<HTMLButtonElement>('play-btn').addEventListener('click', () => setPlaying(!state.playing));
  el<HTMLInputElement>('timeline').addEventListener('input', (e) => {
    state.hourIndex = parseInt((e.target as HTMLInputElement).value, 10);
    onHourChanged();
  });
  const speedRange = el<HTMLInputElement>('speed-range');
  speedRange.addEventListener('input', () => {
    state.boatSpeedKn = parseFloat(speedRange.value);
    el('speed-value').textContent = `${state.boatSpeedKn.toFixed(1)} kn`;
    refreshRoutePanel();
  });

  // Map events.
  map.on('load', () => {
    map.addSource('route-line', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-line',
      paint: { 'line-color': '#0066cc', 'line-width': 3, 'line-opacity': 0.9 },
    });
    void refreshGrid();
  });
  map.on('movestart', () => {
    layerCanvas.style.opacity = '0';
  });
  map.on('moveend', () => {
    layerCanvas.style.opacity = '1';
    layerDirty = true;
    scheduleGridRefresh();
  });
  map.on('mousemove', (e) => {
    const { lat, lng } = e.lngLat;
    el('coords').textContent =
      `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ` +
      `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
  });
  map.on('click', (e) => {
    const { lat, lng } = e.lngLat;
    if (state.routeMode) {
      addWaypoint({ lat, lon: lng });
    } else {
      void openForecast(lat, lng);
    }
  });

  new ResizeObserver(() => sizeCanvases()).observe(el('map-wrap'));
  sizeCanvases();
  updateLegend();
  setStatus('loading', 'Loading data…');
  requestAnimationFrame(frame);
}

init().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : 'Failed to start WhereSail.';
  setStatus('error', msg);
});
