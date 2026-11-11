# M2 screenshots — PDR and Track screen

Taken 2026-11-11 on the test phone (phone at rest on a desk) and from a replay of
`test/data/recordings/rec-2026-11-11T07-18-40`. Status and navigation bars cropped.

| File | Shows |
|---|---|
| `01-track-idle.png` | Track tab before Start: empty grid, hint, Start PDR |
| `02-track-running.png` | PDR running: elapsed time, live heading, 0 steps at rest, GPS distance/error |
| `03-gps-denied.png` | GPS-denied switch on: GPS path and error hidden |
| `04-stopped.png` | After Stop: result stays on screen, GPS revealed again |
| `05-recording-replay.png` | Recorded drive through `src/estimate/pdr.ts`: GPS path vs PDR estimate, rotation-vector heading vs GPS bearing, GPS speed with detected (false) steps, summary |

The drive was in a car, so it validates heading and false-step rejection, not
walking distance. A walking recording is still needed.
