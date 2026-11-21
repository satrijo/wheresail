// Raster layer overlay: paints the coarse Open-Meteo grid as coloured
// quads on a canvas above the basemap. Redrawn only when the grid, the
// selected hour or the layer changes — not every animation frame.

import type { GridField, FieldVar } from './field';

export type LayerId = 'wind' | 'waves' | 'rain' | 'temp';

export interface LayerDef {
  label: string;
  unit: string;
  min: number; // legend minimum (value units)
  max: number; // legend maximum (value units)
  variable: FieldVar;
  alpha: number;
  /** [value, css color] stops; colors are interpolated between stops. */
  stops: [number, string][];
}

export const LAYERS: Record<LayerId, LayerDef> = {
  wind: {
    label: 'Wind speed',
    unit: 'kn',
    min: 0,
    max: 50,
    variable: 'windSpeed',
    alpha: 0.5,
    stops: [
      [0, '#7dd3fc'],
      [10, '#4ade80'],
      [20, '#facc15'],
      [30, '#fb923c'],
      [40, '#ef4444'],
      [50, '#c026d3'],
    ],
  },
  waves: {
    label: 'Wave height',
    unit: 'm',
    min: 0,
    max: 8,
    variable: 'waveHeight',
    alpha: 0.5,
    stops: [
      [0, '#dbeafe'],
      [0.5, '#93c5fd'],
      [1, '#38bdf8'],
      [2, '#0ea5e9'],
      [3, '#facc15'],
      [4, '#fb923c'],
      [6, '#ef4444'],
      [8, '#991b1b'],
    ],
  },
  rain: {
    label: 'Precipitation',
    unit: 'mm/h',
    min: 0,
    max: 10,
    variable: 'precipitation',
    alpha: 0.6,
    stops: [
      [0, 'rgba(186,230,253,0)'],
      [0.1, '#bae6fd'],
      [0.5, '#7dd3fc'],
      [1, '#38bdf8'],
      [2, '#2563eb'],
      [5, '#7c3aed'],
      [10, '#db2777'],
    ],
  },
  temp: {
    label: 'Air temperature',
    unit: '°C',
    min: -5,
    max: 35,
    variable: 'temperature',
    alpha: 0.5,
    stops: [
      [-5, '#7c3aed'],
      [0, '#3b82f6'],
      [10, '#22d3ee'],
      [18, '#4ade80'],
      [24, '#facc15'],
      [30, '#fb923c'],
      [35, '#ef4444'],
    ],
  },
};

/** CSS linear-gradient for the legend bar of a layer. */
export function legendGradient(layer: LayerId): string {
  const def = LAYERS[layer];
  const parts = def.stops.map(([v, c]) => {
    const t = ((v - def.min) / (def.max - def.min)) * 100;
    return `${c} ${Math.max(0, Math.min(100, t)).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(css: string): Rgb {
  if (css.startsWith('rgba')) {
    const m = css.match(/rgba\(([^)]+)\)/);
    const p = m ? m[1].split(',').map((s) => parseFloat(s.trim())) : [0, 0, 0, 1];
    return { r: p[0], g: p[1], b: p[2], a: p[3] };
  }
  const hex = css.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

/** Colour for a value, interpolated between the layer's value stops. */
export function colorFor(layer: LayerId, value: number): string {
  const def = LAYERS[layer];
  const stops = def.stops;
  if (value <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (value >= v0 && value <= v1) {
      const t = v1 === v0 ? 0 : (value - v0) / (v1 - v0);
      const a = parseCssColor(c0);
      const b = parseCssColor(c1);
      const r = Math.round(a.r + (b.r - a.r) * t);
      const g = Math.round(a.g + (b.g - a.g) * t);
      const bl = Math.round(a.b + (b.b - a.b) * t);
      const al = a.a + (b.a - a.a) * t;
      return `rgba(${r},${g},${bl},${al})`;
    }
  }
  return stops[stops.length - 1][1];
}

export function renderLayer(
  ctx: CanvasRenderingContext2D,
  field: GridField,
  layer: LayerId,
  hour: number,
  project: (lat: number, lon: number) => { x: number; y: number },
  width: number,
  height: number,
): void {
  const def = LAYERS[layer];
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = def.alpha;

  const { lats, lons } = field;
  for (let r = 0; r < field.rows - 1; r++) {
    for (let c = 0; c < field.cols - 1; c++) {
      // Cell value = mean of the four corner nodes (skip missing ones).
      const corners = [
        field.node(def.variable, r, c, hour),
        field.node(def.variable, r, c + 1, hour),
        field.node(def.variable, r + 1, c, hour),
        field.node(def.variable, r + 1, c + 1, hour),
      ];
      let sum = 0;
      let n = 0;
      for (const v of corners) {
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (n === 0) continue;
      const value = sum / n;
      // Rain: dry cells stay transparent.
      if (layer === 'rain' && value < 0.05) continue;

      const p00 = project(lats[r], lons[c]);
      const p10 = project(lats[r], lons[c + 1]);
      const p11 = project(lats[r + 1], lons[c + 1]);
      const p01 = project(lats[r + 1], lons[c]);
      // Skip cells entirely off-screen.
      const xs = [p00.x, p10.x, p11.x, p01.x];
      const ys = [p00.y, p10.y, p11.y, p01.y];
      if (
        Math.max(...xs) < -20 ||
        Math.min(...xs) > width + 20 ||
        Math.max(...ys) < -20 ||
        Math.min(...ys) > height + 20
      ) {
        continue;
      }

      ctx.fillStyle = colorFor(layer, value);
      ctx.beginPath();
      ctx.moveTo(p00.x, p00.y);
      ctx.lineTo(p10.x, p10.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.lineTo(p01.x, p01.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
