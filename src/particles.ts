// Animated wind particles on a transparent canvas overlay.
// Particles live in geographic coordinates, move with the interpolated
// wind vector, and are drawn as short trail segments. Trails fade via
// destination-out so the map underneath is never smeared.

export interface WindSample {
  u: number; // knots towards east
  v: number; // knots towards north
  speed: number; // knots
}

export interface ParticleCallbacks {
  project: (lat: number, lon: number) => { x: number; y: number };
  unproject: (x: number, y: number) => { lat: number; lon: number };
  viewBounds: () => { minLat: number; maxLat: number; minLon: number; maxLon: number };
  sampleWind: (lat: number, lon: number) => WindSample | null;
  getZoom: () => number;
}

interface Particle {
  lat: number;
  lon: number;
  age: number;
  maxAge: number;
}

const MAX_PARTICLES = 700;
const MAX_SCREEN_STEP_PX = 30;

export function windColor(speedKn: number): string {
  // Blue -> green -> yellow -> orange -> red -> purple.
  const stops: [number, string][] = [
    [0, '#38bdf8'],
    [10, '#22c55e'],
    [20, '#eab308'],
    [30, '#f97316'],
    [40, '#ef4444'],
    [50, '#a855f7'],
  ];
  const s = Math.max(0, Math.min(50, speedKn));
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (s >= v0 && s <= v1) {
      const t = v1 === v0 ? 0 : (s - v0) / (v1 - v0);
      return mixColor(c0, c1, t);
    }
  }
  return stops[stops.length - 1][1];
}

function mixColor(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export class ParticleField {
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private width = 0;
  private height = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: ParticleCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = cssWidth;
    this.height = cssHeight;
    if (this.particles.length === 0) this.seed();
  }

  seed(): void {
    const count = Math.min(
      MAX_PARTICLES,
      Math.max(150, Math.floor((this.width * this.height) / 2500)),
    );
    this.particles = [];
    for (let i = 0; i < count; i++) this.particles.push(this.randomParticle());
  }

  private randomParticle(): Particle {
    const b = this.cb.viewBounds();
    return {
      lat: b.minLat + Math.random() * (b.maxLat - b.minLat),
      lon: b.minLon + Math.random() * (b.maxLon - b.minLon),
      age: 0,
      maxAge: 40 + Math.random() * 90,
    };
  }

  /** One animation frame: fade old trails, advance and draw each particle. */
  step(): void {
    const { ctx } = this;
    // Fade previous trails towards transparent (map below is untouched).
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';

    // Simulation minutes per frame, zoom-compensated so screen speed is
    // roughly constant: ~8 px/frame at 10 kn at any zoom.
    const zoom = this.cb.getZoom();
    const simMinutes = Math.min(240, Math.max(15, 30 * Math.pow(2, 6 - zoom)));
    const simHours = simMinutes / 60;

    for (const p of this.particles) {
      const w = this.cb.sampleWind(p.lat, p.lon);
      if (!w || p.age >= p.maxAge) {
        Object.assign(p, this.randomParticle());
        continue;
      }
      const prev = this.cb.project(p.lat, p.lon);
      // knots -> degrees: 1 kn = 1 nm/h; 1° latitude = 60 nm.
      let dLat = (w.v * simHours) / 60;
      let dLon = (w.u * simHours) / (60 * Math.cos((p.lat * Math.PI) / 180));
      const nextGeo = { lat: p.lat + dLat, lon: p.lon + dLon };
      const next = this.cb.project(nextGeo.lat, nextGeo.lon);
      // Clamp wild jumps (projection edges, dateline) by scaling the step.
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const dist = Math.hypot(dx, dy);
      if (dist > MAX_SCREEN_STEP_PX) {
        const k = MAX_SCREEN_STEP_PX / dist;
        dLat *= k;
        dLon *= k;
      }
      p.lat += dLat;
      p.lon += dLon;
      p.age++;

      const end = this.cb.project(p.lat, p.lon);
      if (
        Math.abs(end.x - prev.x) > MAX_SCREEN_STEP_PX ||
        Math.abs(end.y - prev.y) > MAX_SCREEN_STEP_PX
      ) {
        Object.assign(p, this.randomParticle());
        continue;
      }
      ctx.strokeStyle = windColor(w.speed);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
