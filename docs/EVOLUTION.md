# App Evolution

How the app grew from "is the data coming in right?" to a car tracker that runs three position engines side by side. Each stage was tested in a car, and what the drive showed decided the next step.

Screenshots are from the test phone. Map tiles are pixelated for privacy.

---

## Stage 0: OBD data in (before M1)
The starting point was a single-screen reader for the Innova 3210RS: connect over BLE, talk ELM327, dump trouble codes and live PIDs. The first real output was a raw debug log from the car (`test/data/obd/obd-debug-2026-11-11T01-43-53-272Z.txt`), plus a scrubber so logs could be committed. How the data is pulled: [HOW_DATA_IS_PULLED.md](HOW_DATA_IS_PULLED.md).

No screenshots of this stage.

## Stage 1: Sensor capture (M1)
Native sensor module and a **Calibrate** tab that records raw accel / gyro / magnetometer / rotation vector at ~100 Hz plus 1 Hz GPS to disk. The goal was just to prove the inputs were good before building anything on them. Later drives confirmed it: max sample gap 10 ms, no dropped rows, high magnetometer accuracy.

No screenshots of this stage; its output is the recordings in `test/data/recordings/`.

## Stage 2: Verifying the data with PDR (M2)
First estimator: pedestrian dead reckoning (step detection + heading). The key check was replaying a **recorded drive** through the code and comparing it to GPS.

| | |
|---|---|
| ![Replay of a recorded drive](screenshots/m2/05-recording-replay.png) | **Data verification.** A real drive replayed through `pdr.ts`: GPS path vs estimate, rotation-vector heading vs GPS bearing, GPS speed with detected steps. Heading tracked GPS, so the sensor data was usable. The "steps" were false ones from road bumps. |
| ![Track idle](screenshots/m2/01-track-idle.png) | Track tab before Start. |
| ![Track running](screenshots/m2/02-track-running.png) | PDR running: time, live heading, steps, GPS distance and error. |
| ![GPS denied](screenshots/m2/03-gps-denied.png) | GPS-denied mode: GPS path and error hidden while running. |
| ![Stopped](screenshots/m2/04-stopped.png) | After Stop: GPS revealed for comparison. |

## Stage 3: The map (M3)
Offline MapLibre map with both paths, per-second error lines and a max/mean error HUD.

| | |
|---|---|
| ![Before fix](screenshots/m3/01-grid-before-fix.png) | No GPS fix yet: falls back to the grid. |
| ![Map live](screenshots/m3/02-map-live.png) | Live on the map with Fit / Lock / Offline and the error HUD. |
| ![Offline saved](screenshots/m3/07-offline-saved.png) | Offline tile pack saved for the trip + 1.5 km. |
| ![GPS denied running](screenshots/m3/08-gps-denied-running.png) | GPS-denied on the map. |
| ![GPS denied revealed](screenshots/m3/09-gps-denied-revealed.png) | Revealed after Stop. |

### What the M3 drive showed
- **The OBD connection silently died.** After switching tabs, the Vehicle screen was back at **Connect & Read**. The log showed the dongle dropping the link after ~4 min with no sign in the app.
- **The map jumped** to refit the whole trip on every GPS update.
- **No estimate line in the car** (test item 1.7 ❌). PDR can't track a car.

## Stage 3b: M3 revision, from the drive feedback
Map recenters only near the edge, pauses after a touch, and can be locked:

| | |
|---|---|
| ![Recenter paused](screenshots/m3/03-recenter-paused.png) | Dragged by hand: recentering paused 10 s. |
| ![Recentered](screenshots/m3/04-recentered.png) | 10 s later: recentered at the same zoom. |
| ![Locked](screenshots/m3/05-locked.png) | 🔒 Locked: no recentering. |
| ![Fit while locked](screenshots/m3/06-fit-while-locked.png) | ⌖ Fit while locked: fits once, lock stays on. |

OBD became a shared, persistent session with visible states and auto-reconnect:

| | |
|---|---|
| ![OBD idle](screenshots/m3/11-obd-idle.png) | Idle: blue Connect & Read. |
| ![OBD connecting](screenshots/m3/12-obd-connecting.png) | Connecting: amber, current step, Cancel. |
| ![OBD error](screenshots/m3/13-obd-error.png) | Dongle not found after 3 retries: red with the reason. |
| ![OBD badge](screenshots/m3/10-obd-badge-on-track.png) | OBD badge visible from the Track tab. |

## Stage 4: Sessions, replay and export (M4)
Every recording can be reopened, replayed and exported.

| | |
|---|---|
| ![Sessions list](screenshots/m4/01-sessions-list.png) | Saved recordings with duration, size, GPS fixes. |
| ![Replay full trip](screenshots/m4/02-replay-full-trip.png) | A 5:31 drive replayed: error links and stats. PDR's max error is 852.9 m, which made the case for a car engine. |
| ![Replay scrubbed](screenshots/m4/03-replay-scrubbed-32x.png) | Scrubbed and played at 32×. |
| ![Export](screenshots/m4/04-export-share-sheet.png) | GPX + error CSV to the share sheet. |
| ![Stationary](screenshots/m4/05-stationary-session.png) | Stationary session: 0 steps, 0.4 m error. |

## Stage 5: Car engines (M5)
Added **INS** (strapdown with zero-velocity resets) and **Wheel** (OBD speed + a forward axis learned from speed-ups and brakes), with an engine picker and all three lines drawn together, live and on replay.

| | |
|---|---|
| ![Track three engines](screenshots/m5/06-track-three-engines.png) | Live Track: legend for GPS / PDR / INS / Wheel. At rest INS shows "(still)"; Wheel waits for OBD. |
| ![Replay Wheel](screenshots/m5/01-replay-wheel.png) | Test drive replayed with **Wheel**: green estimate follows the blue GPS roads, rotated by a fixed heading offset. |
| ![Replay INS](screenshots/m5/02-replay-ins.png) | Same drive with **INS**: purple drifts off the map. |
| ![Replay PDR](screenshots/m5/03-replay-pdr.png) | **PDR**: stays near the start. STEPS 11 after the OBD gating fix (was 115). |
| ![Replay scrubbed](screenshots/m5/04-replay-scrubbed.png) | Scrubbed to 2:23: every line cut at the playhead. |
| ![No OBD](screenshots/m5/05-replay-no-obd.png) | Session with no OBD: only PDR and INS, "no OBD speed → no wheel". |

Results from the test drive (2.79 km):

| Engine | Mean error | Final error / distance |
|---|---|---|
| **Wheel** | **156 m** | **4.6 %** |
| INS | 814 m | 28.3 % |
| PDR | 363 m | stays at the start |

### What the M5 drive showed
- **PDR counted 115 false steps** in the car, failing an existing unit test on the new recording. Fixed: PDR ignores steps while OBD says the car is moving (115 → 11).
- **OBD speed is accurate** (OBD/GPS ratio 1.003). Live and replay match to under 1 m.
- **Wheel's main error is a fixed heading offset** (~19°), because the learned axis freezes early. Next to fix.
- **Polling gaps** (full-PID cycles, a 20 s link drop) cost distance.

Details: [TEST_OVERVIEW.md](TEST_OVERVIEW.md) and [m4-m5-insights.md](test-plans/m4-m5-insights.md).

## Next (M6)
Heading-axis refinement, PID 0D every cycle with interpolation, foreground service, battery tuning.
