// Smoke test for WhereSail core logic (field sampling, route math, colors).
// Run: npx esbuild src/field.ts src/route.ts src/overlay.ts --bundle --format=esm --outfile=/tmp/wheresail-test.mjs && node /tmp/wheresail-test.mjs
import { GridField } from '../src/field';
import { computeLegs, haversineNm } from '../src/route';
import { colorFor } from '../src/overlay';

let failures = 0;
function check(name, cond, got) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name} — got: ${JSON.stringify(got)}`);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// Synthetic 3x3 grid, 2 hours. windSpeed = r*10 + c; wind u=10, v=0 everywhere.
const rows = 3;
const cols = 3;
const hours = 2;
const size = hours * rows * cols;
const mk = (fn) => {
  const a = new Float32Array(size).fill(NaN);
  for (let h = 0; h < hours; h++)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) a[(h * rows + r) * cols + c] = fn(h, r, c);
  return a;
};
const grid = {
  times: ['2026-11-21T00:00', '2026-11-21T01:00'],
  lats: [-8, -7, -6],
  lons: [108, 109, 110],
  rows,
  cols,
  hours,
  windU: mk(() => 10),
  windV: mk(() => 0),
  windSpeed: mk((_h, r, c) => r * 10 + c),
  temperature: mk(() => 28),
  precipitation: mk(() => 0),
  waveHeight: mk((_h, r, c) => (r === 0 && c === 0 ? NaN : 1.5)),
  waveDirection: mk(() => 180),
  wavePeriod: mk(() => 8),
};
const field = new GridField(grid);

// 1. Bilinear at cell centre (-7.5, 108.5): corners 0,1,10,11 -> 5.5
check('bilinear centre = 5.5', approx(field.sample('windSpeed', -7.5, 108.5, 0), 5.5), field.sample('windSpeed', -7.5, 108.5, 0));
// 2. Exact node
check('node (-7,109) = 11', approx(field.sample('windSpeed', -7, 109, 0), 11), field.sample('windSpeed', -7, 109, 0));
// 3. Wind vector
const w = field.windVector(-7.5, 108.5, 0);
check('windVector u=10 v=0 speed=10', !!w && approx(w.u, 10) && approx(w.v, 0) && approx(w.speed, 10), w);
// 4. NaN corner excluded: wave at (-8,108) corner missing -> mean of remaining 3
const wh = field.sample('waveHeight', -7.9, 108.1, 0);
check('NaN corner excluded, wave ~1.5', approx(wh, 1.5), wh);
// 5. Haversine: 1 degree of longitude at lat -7.7 ~ 59.46 nm
const d = haversineNm({ lat: -7.7, lon: 109 }, { lat: -7.7, lon: 110 });
check('haversine 1 deg lon ~59.46nm', Math.abs(d - 59.46) < 0.5, d);
// 6. Route legs: 59.46 nm at 6 kn -> ~9.9 h
const { legs, totalNm, totalHours } = computeLegs(
  [
    { lat: -7.7, lon: 109 },
    { lat: -7.7, lon: 110 },
  ],
  field,
  0,
  6,
);
check('leg distance', Math.abs(totalNm - 59.46) < 0.5, totalNm);
check('leg ETA ~9.9h', Math.abs(totalHours - 59.46 / 6) < 0.1, totalHours);
check('leg wind 10kn', legs[0].windKn !== null && approx(legs[0].windKn, 10), legs[0]);
// 7. Colours
check('wind 0kn colour', colorFor('wind', 0) === '#7dd3fc', colorFor('wind', 0));
check('wind 50kn colour', colorFor('wind', 50) === 'rgba(192,38,211,1)', colorFor('wind', 50));
check('rain 0 transparent', colorFor('rain', 0).includes('rgba(186,230,253,0)'), colorFor('rain', 0));

if (failures > 0) {
  console.log(`${failures} FAILURES`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
