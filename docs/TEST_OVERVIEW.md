# Test Overview

Testing was done in this order of importance:

1. **Manual testing in a real car**, driven and judged by hand. This found the bugs that mattered.
2. **Live data**: real drives recorded on the phone, scrubbed, committed, and replayed through the app's own code.
3. **Unit tests**: Jest, mostly built from what 1 and 2 turned up (summary at the bottom).

All testing was on 2026-11-11 on one Android phone with an Innova 3210RS.

---

## 1. Issues found by manual testing and personal feedback

These came from driving, not from the unit tests. Each changed the app.

| # | Found in | What happened | What changed |
|---|---|---|---|
| 1 | M3 drive (tab switches) | Connected to OBD, switched tabs, came back: the Vehicle screen showed **Connect & Read** again. Reading had silently stopped. | The drive's OBD log showed the dongle closing the link (`GATT_CONN_TERMINATE_PEER_USER`) after ~4 min, which ended the read loop with no visible sign. OBD moved to a shared session (`src/obd/session.ts`) that reads until **Stop**, retries 3× with 2/4/8 s backoff, and shows colour-coded states plus a badge on every tab. (Commit `9b88afe`) |
| 2 | M3 drive (map) | The map refit the whole trip on every GPS update. It kept jumping, and after a manual pan it stayed put until **Fit** was tapped. | Map now keeps the zoom and recenters only near the edge (15 % margin), pauses 10 s after a touch, and has a **🔒 Lock** toggle. (`9b88afe`) |
| 3 | M3 drive, item 1.7 ❌ | The orange estimate line was **not visible** in the car. PDR (step counting) can't estimate a car's path. | Confirmed the need for a car engine: M5 added **Wheel** (OBD speed + learned heading axis) and **INS**. |
| 4 | M4/M5 drive data | PDR counted **115 false "steps" in 412 s** of driving. The existing `driving: few false steps` test **failed** on this recording. | PDR ignores steps while OBD shows the car moving (speed > 0, reading < 6 s old). Replay drops from 115 to 11 steps; test passes again. (Commit `abb2723`) |
| 5 | M3 revision | Other BLE gadgets advertising the same FFF0 service could be picked instead of the dongle. | Connect checks `ATZ`/`ATI` and skips non-ELM327 devices. |
| 6 | M4/M5 drive data | ~40 "user moved map" events in bursts; each pushed the 10 s pause back, so the map never recentered during that stretch. | Recorded; not changed yet. |

### Open items from the drives (not fixed yet)
- **Wheel heading has a fixed offset**, not noise: median −18.9° on the test drive (−33.4° on another). The forward axis freezes after 40 speed-ups/brakes, so an early error stays for the whole trip.
- **OBD gaps cost distance**: every ~10th cycle reads all 43 PIDs (4.4 s gaps). A 20.3 s link drop counted the car as stopped for ~14 s. Fix: poll PID 0D every cycle and interpolate on replay.
- **INS drifts into kilometres** (2.3 km max), as expected for a phone IMU.

### Skipped manual items
- M3: 1.3 faster road, 1.4 red light, 1.5 tunnel, all of 7 (long drive / battery / heat).
- M4/M5: 6.5 export and 7.1 replay in airplane mode ("forgot airplane mode").
- PDR walking distance: still needs a walking recording.

---

## 2. Manual test plans and results

| Plan | Scope | Result |
|---|---|---|
| [m3-map.md](test-plans/m3-map.md) | Map, GPS path, tab switches, GPS-denied, offline tiles | 26 ✅ · 1 ❌ (estimate line in a car) · 6 ⏭ |
| [m4-m5-sessions-engines.md](test-plans/m4-m5-sessions-engines.md) | Live engines, sessions list, replay, export, delete, bench checks | All ✅ except 2 ⏭ (airplane mode) |
| Device checks for M1/M2 | Sensor capture, Track screen states | Passed on device; see [screenshots/m2](screenshots/m2/README.md) |

Highlights that passed in the car:
- Tab switches during a drive: OBD, recording and all three engines kept running with no gap.
- Unplugging the dongle mid-route: reconnecting/error shown, Wheel stops adding distance after ~6 s, resumes when plugged back in.
- GPS-denied mode hides GPS and errors while driving, reveals them on Stop.
- Offline tiles load along the route in airplane mode; off-area shows the banner.
- Replay at 1×/8×/32×, scrubbing, engine switching, GPX/CSV export (GPX checked in gpx.studio).

---

## 3. Live data

Committed and scrubbed (GPS moved to a neutral anchor, VIN/IDs/MACs removed). See [test/README.md](../test/README.md).

| Recording | Length | GPS distance | Used for |
|---|---|---|---|
| `rec-2026-11-11T07-18-40` | 2:02 | 0.77 km | M2 PDR replay, heading check |
| `rec-2026-11-11T08-28-51` | ~0:51 | ~0 | Stationary session (no false steps) |
| `rec-2026-11-11T08-51-52` | 5:32 | 2.35 km | M3/M4 drive, replay, engines |
| `rec-2026-11-11T10-23-12` | 6:52 | 2.79 km | M4/M5 test drive |

Plus 8 OBD debug logs in `test/data/obd/`.

### Engine accuracy (replay of the real drives)

| Drive | Engine | Est. dist | Mean err | Max err | Final err / dist |
|---|---|---|---|---|---|
| 10-23-12 (2793 m) | **Wheel** | 2635 m | **156 m** | 269 m | **4.6 %** |
| | INS | 3625 m | 814 m | 2340 m | 28.3 % |
| | PDR | 74 m | 363 m | 846 m | (fluke, never left start) |
| 08-51-52 (2353 m) | **Wheel** | 1865 m | 95 m | 361 m | 15.3 % |
| | INS | 1558 m | 886 m | 1539 m | 58.2 % |
| 07-18-40 (771 m) | **Wheel** | 744 m | 225 m | 336 m | 35.4 % |
| | INS | 343 m | 136 m | 297 m | 38.5 % |

What the data showed:
- **OBD speed is accurate**: OBD/GPS ratio 1.003 (0.985 and 0.995 on the other drives).
- **Live and replay agree**: Wheel 2634.3 m live vs 2635 m on replay.
- **Recording is healthy**: steady ~100 Hz IMU, max gap 10 ms, no dropped rows, 19–34 satellites, ~3.8 m GPS accuracy. OBD reconnected by itself in 7.3 s after a link drop.

Full analysis: [m4-m5-insights.md](test-plans/m4-m5-insights.md).

---

## 4. Unit test summary

`npm test`: **9 suites, 51 tests, all passing** on the last full run.

| Suite | Tests | Covers |
|---|---|---|
| `pdr.test.ts` | synthetic + one block per recording | Step detection, square walk closes, still phone → no steps; on each real recording: GPS→local metres, heading tracks GPS bearing, few false steps in a car |
| `replay.test.ts` | unit + one per recording | CSV parsing, timezones, deterministic replay, playhead cuts, GPX/CSV export, no-GPS sessions |
| `m5.test.ts` | 8 | INS ZUPT and ½at², Wheel learns a sideways mount, stale speed stops the car, OBD speed parsing, PDR gated by OBD |
| `obdSession.test.tsx` | 5 | Fake BLE dongle: reads through tab switches until Stop, reconnects, gives up after 3, skips impostor device, Bluetooth off |
| `overlay.test.ts` | 5 | Error stats, GeoJSON, bounds, `nearEdge` for recentering |
| `imu.test.ts` | 4 | Heading from quaternion, gyro bias |
| `tabs.test.tsx` | 1 | Tab switches keep sensors, recording and PDR running |
| `sessions.test.tsx` | 1 | List, open, replay, scrub, play, export |
| `App.test.tsx` | 1 | Renders |

Known issue: `obdSession.test.tsx` passed alone and in one full run but failed in another full run (`--verbose`). It looks timing-sensitive under load. Jest also warns that a worker didn't exit cleanly (an open timer).
