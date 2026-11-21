# WhereSail — Sailing weather, mapped

An interactive maritime weather map for sailors — Windy-like, but focused on
sailing. A portfolio demo: the map really works with live data, the code is
clean and public-ready.

**Live demo:** not deployed yet (local prototype).
**Stack:** TypeScript + Vite (vanilla, no heavy framework) + MapLibre GL JS.
**Data:** Open-Meteo Forecast API (GFS wind/temperature/rain) and Marine API
(ICON waves), both free and keyless.

## Features

1. **Live map + animated wind particles** — a canvas overlay of particles
   that flow along the interpolated wind field (bilinear interpolation of
   the u/v wind components), coloured by wind speed.
2. **Layer switcher** — Wind (kn), Waves (m), Rain (mm/h), Temperature (°C).
   Each layer paints the data grid as coloured quads over the basemap, with
   a legend.
3. **Timeline slider** — 48 hourly steps from the current hour; a play button
   animates the forecast. Moving the slider updates particles, layers, the
   forecast panel and route ETAs.
4. **Click anywhere → 48-hour point forecast** — wind speed/direction,
   wave height + period, sea/air temperature, rain; with wind and wave
   sparklines and a scrollable hourly table.
5. **Route planner** — toggle Route mode, click to drop waypoints (numbered
   markers + line). Each leg shows distance (nm), mid-leg wind and waves
   for the selected forecast hour, and sailing time at a configurable boat
   speed (4–10 kn, default 6 kn). Click a waypoint to remove it; Clear route
   resets.
6. **Clean UI** — header with name + tagline, layer buttons, boat-speed
   control, live coordinate readout, data-status pill (click to retry on
   error).

Deliberately **not** included: accounts, payments, alerts, backend, AIS,
tides.

## Run it

```bash
npm install
npm run dev      # http://127.0.0.1:5173
npm run build    # typecheck + production build -> dist/
npm run preview  # serve the production build locally
```

Requires Node 18+ and npm. No API keys, no backend, no environment variables.

## How the data works

Open-Meteo has **no raster tiles**, so WhereSail fetches a coarse point grid
instead:

- On map idle (debounced 500 ms), the visible bounding box is sampled on a
  grid — step depends on zoom (5° world view → 0.5° zoomed in), capped at
  ~400 points — in **one request per API** (Open-Meteo accepts
  comma-separated latitude/longitude lists and returns locations in request
  order).
- Grid responses are cached in memory for 10 minutes; point forecasts are
  cached the same way.
- The grid is rendered as coloured quads (one per cell) and bilinearly
  interpolated for particles, the route midpoints and the click forecast.
- Marine variables are `null` over land; those cells are skipped (waves layer)
  and sampling falls back to the remaining corners.

## Architecture

```
src/
  main.ts       — bootstrap, map, UI wiring, animation loop, grid refresh
  api.ts        — Open-Meteo Forecast + Marine clients, cache, error mapping
  field.ts      — GridField: bilinear sampling of the gridded data
  particles.ts  — wind particle system (canvas overlay)
  overlay.ts    — raster layer rendering + colour scales + legend
  panel.ts      — 48 h point-forecast panel (stats, sparklines, table)
  route.ts      — route legs: haversine distance, mid-leg weather, ETA
  style.css     — clean light professional theme
```

Basemap: Carto Positron (free, no key), with an inline OSM raster style as
fallback if Carto is unreachable.

## Limitations (honest notes)

- **Coarse grid.** At world zoom the wind field is sampled every 5°, so
  particles and colours are smooth approximations, not the high-resolution
  fields a service like Windy renders. Zooming in refines the grid (down to
  0.5°). Coastal detail and small-scale effects (sea breeze, gusts, local
  funnelling) are not resolved.
- **Free-tier quota.** Open-Meteo allows 10,000 requests/day per IP. Behind
  a shared egress IP (office/VPN) the quota can be exhausted by other users;
  the app then shows a rate-limit message in the status pill instead of
  data. On a normal home connection this is rarely hit (a grid refresh is
  2 requests).
- **Model data, not observations.** Wind is GFS, waves are ICON — forecasts
  with model error, not live sensor readings.
- **No offline mode.** The map needs network access to Open-Meteo, Carto
  and (fallback) OSM tile servers.
- **Dateline.** When the view crosses the antimeridian the grid fetch is
  clamped to the half holding the view centre; the far half shows no layer
  until you pan across.
- **48-hour horizon only.** The timeline covers the next 48 hours
  (`forecast_days=2`).

## Data sources & attribution

- Weather & marine data: [Open-Meteo](https://open-meteo.com/) (GFS, ICON),
  CC BY 4.0.
- Basemap: © OpenStreetMap contributors, © CARTO.
