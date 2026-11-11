# OBD App — Transformation Plan

Turn the current OBD-II BLE reader (bare React Native 0.88, `react-native-ble-plx`, Android-first, native `DebugLogModule`) into the **OBD App**, which works offline: estimate position from the phone's accelerometer, gyroscope and magnetometer with GPS off, then draw the estimated path next to the real GPS path on an offline map so drift is visible.

The existing OBD-II link becomes an optional bonus: vehicle speed (PID `0x0D`) is a far better velocity source than integrating acceleration, so it can be shown as a third "estimate + wheel speed" track.

---

## 1. Goals

| Goal | Measure of done |
|---|---|
| Estimate position with no GPS fix | Path drawn live from IMU alone |
| Show drift honestly | GPS truth path + estimate path + error stats on one map |
| Work fully offline | Map tiles, sessions, replay all run in airplane mode |
| Be inspectable | Every session exportable (CSV/GPX/GeoJSON) and replayable |

Non-goals (v1): iOS polish, cloud sync, map matching, visual odometry.

---

## 2. Feature list

### P0 — MVP
1. **Sensor capture** — accelerometer, gyroscope, magnetometer, (game) rotation vector at 50–100 Hz via a native Android module (`SensorManager`), batched to JS every ~100 ms. Timestamps from `event.timestamp` (monotonic ns).
2. **Orientation estimate** — Android rotation vector as baseline; Madgwick/complementary filter in TS as an alternative. Heading = yaw relative to magnetic north + declination.
3. **Position-estimate engines** (selectable):
   - **PDR (walking):** step detection on accel magnitude, step length (Weinberg model), heading per step. Most robust for phones.
   - **INS (strapdown):** gravity removal, rotate to ENU, double-integrate with ZUPT (zero-velocity updates) when stationary. Shows the classic quadratic drift.
   - **Wheel-speed (vehicle):** OBD-II speed × heading. Reuses the existing BLE code.
4. **Reference GPS track** — recorded in parallel (`FusedLocationProvider`/`LocationManager`) but **never fed into** the estimator. Toggle "GPS-denied mode" to hide it during the run, reveal afterward.
5. **Start anchor** — estimate starts from last GPS fix, a long-press on the map, or (0,0) local frame.
6. **Offline map** — MapLibre Native (`@maplibre/maplibre-react-native`) with a bundled/downloaded `.mbtiles` or PMTiles region. Falls back to a plain grid in local metres.
7. **Path overlay** — GPS (truth) line, estimate line, per-second error connectors between matching timestamps.
8. **Live HUD** — elapsed time, distance (estimate vs GPS), current error (m), error as % of distance travelled, heading, step count/speed, sensor rates.
9. **Session recording** — raw sensor stream + GPS + estimate output saved locally (SQLite or append-only NDJSON).

### P1 — Analysis
10. **Session list & replay** — scrub a timeline, re-run with a different engine/params on the same raw data (deterministic).
11. **Drift chart** — error (m) vs time and vs distance; heading error vs time.
12. **Calibration screen** — magnetometer figure-8 calibration, gyro bias capture while still, step-length calibration over a known distance.
13. **Export** — GPX (both tracks), GeoJSON, raw CSV; share via Android share sheet. Reuse `DebugLogModule` FileProvider plumbing.
14. **Offline region manager** — pick a bounding box, download tiles while online, show storage used.

### P2 — Nice to have
15. **Loop-closure / known-landmark correction** — tap "I'm here" to reset error and log the correction.
16. **Particle filter with map constraints** (stay on roads/walkable areas).
17. **Barometer** for floor/altitude changes.
18. **Engine comparison overlay** — PDR vs INS vs wheel-speed on the same session.

---

## 3. Architecture

```
┌──────────────── Android native (Kotlin) ────────────────┐
│ SensorModule     → batched IMU frames (ts, ax..mz, quat) │
│ LocationModule   → GPS fixes (ts, lat, lon, acc)         │
│ BLE (ble-plx)    → OBD speed (existing)                  │
│ Foreground service so capture survives screen-off        │
└───────────────┬─────────────────────────────────────────┘
                │ events
┌───────────────▼──────────── TypeScript ─────────────────┐
│ src/sensors/      subscribe, resample, buffer            │
│ src/fusion/       orientation filter, gravity removal    │
│ src/estimate/     pdr.ts · ins.ts · wheel.ts (pure fns)  │
│ src/geo/          ENU⇄WGS84, haversine, declination      │
│ src/session/      record, persist, replay, export        │
│ src/ui/           screens below                          │
└──────────────────────────────────────────────────────────┘
```

Key principle: **estimate engines are pure functions over a recorded stream** → identical results live and on replay, and unit-testable with Jest against fixtures in `test/data/`.

### Dependencies to add
- `@maplibre/maplibre-react-native` — offline vector/raster tiles
- `react-native-svg` + small chart lib (or `victory-native`) — drift chart
- `@op-engineering/op-sqlite` or `react-native-mmkv` — session storage
- `@react-navigation/native` + bottom tabs
- `geomagnetism` (pure JS) — magnetic declination, offline

---

## 4. Screens / UI mocks

Five screens on a bottom tab bar: **Track · Sessions · Calibrate · Maps · Settings**.

### 4.1 Track (live)

```
┌────────────────────────────────────┐
│ ◉ REC 04:12      GPS-denied: ON  ⚙ │
├────────────────────────────────────┤
│        ·  ·  offline map  ·  ·     │
│     ┌─────────┐                    │
│     │ ███ GPS │      ●━━━━━━━┓     │
│     │ ─── EST │      ┃  ╭────┃╮    │
│     └─────────┘   ●━━┛ ╱     ┃│    │
│              ╭───────╯  ┆   ┃│    │
│   S ●━━━━━━━━┷━━━━━━━━━━┆━━━┛│    │
│      ╰──────────────────╯ ▲  │    │
│                     err 23 m ◀ EST│
│                                    │
├────────────────────────────────────┤
│  DIST EST 612 m│ GPS 640 m          │
│  ERROR  23.4 m │ 3.7 % of distance  │
│  HDG 087° E    │ STEPS 812 · 1.3m/s │
│  IMU 100 Hz ✓  │ MAG ⚠ recalibrate  │
├────────────────────────────────────┤
│ [ Engine: PDR ▾ ]  [■ STOP] [⌖ FIX]│
├────────────────────────────────────┤
│  Track  Sessions  Calib  Maps  Set │
└────────────────────────────────────┘
```
- Solid line = GPS truth, dashed = estimate estimate, dotted connectors = per-second error.
- "GPS-denied: ON" hides the GPS line until stop (blind test).
- ⌖ FIX = manual landmark correction (P2).

### 4.2 Session detail / replay

```
┌────────────────────────────────────┐
│ ← Morning walk · 11 Nov · 18:42    │
├────────────────────────────────────┤
│   [ map with GPS ━━ / PDR ── /     │
│     INS ┄┄ tracks overlaid ]       │
├────────────────────────────────────┤
│ ▶  ━━━━━━━━━━●━━━━━━━━━━━  09:31   │
│    1×  2×  8×                      │
├────────────────────────────────────┤
│ Error (m)                          │
│ 60┤                       ╱ INS    │
│ 40┤                   ╱╱╱          │
│ 20┤        ___----‾‾‾‾  PDR        │
│  0┼──────────────────────── t      │
├────────────────────────────────────┤
│ Final err  PDR 31 m  INS 410 m     │
│ Max err    PDR 38 m  INS 410 m     │
│ Err/dist   PDR 2.4%  INS 32%       │
├────────────────────────────────────┤
│ [Re-run with…] [Export GPX] [CSV]  │
└────────────────────────────────────┘
```

### 4.3 Sessions list

```
┌────────────────────────────────────┐
│ Sessions                     ⇅ ⌕   │
├────────────────────────────────────┤
│ ▪ Morning walk     1.3 km  2.4% ▸  │
│   PDR · 11 Nov 18:42 · 21 min      │
│ ▪ Drive to store   4.8 km  0.9% ▸  │
│   Wheel+OBD · 10 Nov · 9 min       │
│ ▪ Desk drift test  0 m    —   ▸    │
│   INS · 10 Nov · 5 min · 14 m drift│
└────────────────────────────────────┘
```

### 4.4 Calibrate

```
┌────────────────────────────────────┐
│ Calibration                        │
├────────────────────────────────────┤
│ Gyro bias        ✓ 0.002 rad/s     │
│   [ Hold still 10 s ]              │
│ Magnetometer     ⚠ accuracy LOW    │
│   [ Wave phone in figure-8 ]  ∞    │
│ Step length      0.74 m (auto)     │
│   [ Walk known 50 m ]              │
│ Declination      +11.2° (offline)  │
├────────────────────────────────────┤
│ Live: ax 0.01 ay 0.03 az 9.80      │
│       gx .001 gy .000 gz .002      │
│       |m| 48 µT  heading 087°      │
└────────────────────────────────────┘
```

### 4.5 Offline maps

```
┌────────────────────────────────────┐
│ Offline regions          [+ New]   │
├────────────────────────────────────┤
│ ▪ Home area   z10–17   84 MB  ✓    │
│ ▪ Downtown    z12–18  212 MB  ✓    │
├────────────────────────────────────┤
│ New: drag box on map, pick zoom    │
│ Est. size 120 MB · Wi-Fi only ☑    │
│ [ Download ]                       │
└────────────────────────────────────┘
```

---

## 5. Migration from current repo

| Current | Becomes |
|---|---|
| `App.tsx` (single OBD screen) | Navigation shell; OBD UI moves to Settings → "Vehicle speed source" |
| `react-native-ble-plx` OBD polling | `src/estimate/wheel.ts` speed provider (PID 0x0D only, ~5 Hz) |
| `DebugLogModule.kt` + FileProvider | Reused for session export / share sheet |
| `test/data/obd/*.txt` + `test/scripts/scrub_obd_log.py` | Recorded sessions in `test/data/recordings/` (scrubbed with `scrub_recording.py`) become fixtures for Jest tests of estimate engines |
| `AndroidManifest.xml` | Add `ACCESS_FINE_LOCATION`, `HIGH_SAMPLING_RATE_SENSORS`, `FOREGROUND_SERVICE_LOCATION`, `ACTIVITY_RECOGNITION` |

## 6. Milestones

1. ✅ **M1 Sensors** — native SensorModule, live raw readout on Calibrate screen. *Done and tested on device (commit 832500c).*
2. ✅ **M2 PDR** — step detect + heading → path on local grid; GPS recorded alongside. *Done (commit bb2cca6): `src/estimate/pdr.ts`, `src/geo/enu.ts`, Track tab, replay tests in `__tests__/pdr.test.ts`; tested on device and on the recorded drive. Screenshots in `docs/screenshots/m2/`. Walking-distance accuracy still to be checked with a walking recording.*
3. ✅ **M3 Map** — MapLibre offline tiles, both paths + error HUD. *Done (commit ebc29b2, revision 9b88afe): Track map with GPS/estimate paths, per-second error lines, max/mean error, offline tile packs; revision added edge recentering with a 10 s pause after touch, a recenter lock, and a persistent OBD session (src/obd/session.ts) with reconnect and colour-coded states. Driving test plan in `docs/test-plans/m3-map.md`; screenshots in `docs/screenshots/m3/`. The driving estimate (OBD wheel speed) is still M5.*
4. ✅ **M4 Sessions** — persist, list, replay, export GPX/CSV. *Done (commit 63f0893): Sessions tab lists recordings and replays them through PDR (`src/session/replay.ts`) with map, scrubber, 1×/8×/32× playback and error stats; exports GPX (GPS + estimate tracks) and per-second error CSV via the share sheet, also kept in the session's `exports/` folder. Tests in `__tests__/replay.test.ts` and `__tests__/sessions.test.tsx`; verified on device.*
5. **M5 INS + Wheel** — strapdown with ZUPT; OBD speed engine; comparison overlay.
6. **M6 Polish** — calibration flows, drift chart, foreground service, battery tuning.

## 7. Risks

- **Magnetic disturbance** (cars, steel buildings) wrecks heading → use gyro-dominant fusion, flag `|m|` anomalies.
- **Pure INS drift** is metres within seconds on phone-grade IMUs → frame it as the demo of *why* PDR/ZUPT/wheel speed matter.
- **Android sensor throttling** (200 Hz cap, background limits) → foreground service + `HIGH_SAMPLING_RATE_SENSORS`.
- **Tile licensing** → use OpenStreetMap-derived tiles with attribution; don't bulk-scrape tile.openstreetmap.org (use Protomaps/OpenFreeMap extracts).
