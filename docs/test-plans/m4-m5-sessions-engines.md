# M4 Sessions + M5 Engines — Manual Test Plan (driving + bench)

**Scope:** M4 session list, replay, scrubber, playback speeds, GPX/CSV export and delete. M5 INS and Wheel (OBD speed) engines, live and on replay, the engine picker and the comparison overlay.

**What to expect from the engines:**
- **Wheel** (green) should follow roads in a car. Its distance should be close to GPS. Heading can be off by 20–40° until it has seen a few speed-ups and brakes (AXIS learned ×N).
- **INS** (purple) drifts badly in a car, because engine vibration stops it from ever detecting the car as still. Record how it behaves rather than failing it for drift.
- **PDR** (orange) stays near the start in a car.

**Safety:** set everything up while parked. A passenger should operate the phone, or it should sit in a mount and not be touched while moving.

Mark each: ✅ pass · ❌ fail (note what happened) · ⏭ skipped.

## 0. Setup (parked, engine on)
| # | Step | Expected | Result |
|---|---|---|---|
| 0.1 | Phone online, location on, mounted firmly in the car (any angle) | — | ✅ |
| 0.2 | **Vehicle (OBD)** tab → connect to the 3210RS | Connects; km/h updates | ✅ |
| 0.3 | **Calibrate** → **● Start recording** | REC shows; GPS fix count rises | ✅ |
| 0.4 | **Track** → **▶ Start**, wait for a GPS fix | Map at your location; legend shows ● PDR ● INS ● Wheel | ✅ |
| 0.5 | Stats panel OBD line | Shows "0 km/h" (not "idle (wheel needs OBD)") | ✅ |

## 1. Drive: live engines (M5)
Plan a route of about 10–15 min with turns, at least 3 stops, and some faster road.

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Passenger taps **● Wheel** in the legend | Wheel is underlined; title shows ◉ Wheel; green line is the main thick one | ✅ |
| 1.2 | Pull out and accelerate | AXIS goes from "—" to "learned ×1", then rises | ✅ |
| 1.3 | Drive straight 30 s | Green line runs parallel to blue; note the angle between them | ✅ |
| 1.4 | Turns | Green line turns when the car turns (by roughly the same angle) | ✅ |
| 1.5 | Stop light | Green line stops; WHEEL distance stops rising | ✅ |
| 1.6 | After 5 min: DIST EST (Wheel) vs GPS | Within ~25% of each other | ✅ |
| 1.7 | ERROR / MAX / MEAN with Wheel selected | Note the values at 5 min and at the end | ✅ |
| 1.8 | Tap **● INS**, then **● PDR**, then back to **● Wheel** | Main line, error links and DIST EST switch; the other two stay as thin lines | ✅ |
| 1.9 | INS line and "(still)" flag while stopped | Note whether "(still)" ever shows in the car and where the purple line goes | ✅ |
| 1.10 | Unplug the dongle or switch the ignition off briefly while parked mid-route | OBD line shows reconnecting/error; Wheel stops adding distance after ~6 s; plug back in → resumes | ✅ |

## 2. Tab switches while driving (passenger only)
| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Switch Track → Vehicle → Sessions → Calibrate → Track a few times | All three lines continue with no gap; WHEEL distance kept rising | ✅ |
| 2.2 | Sessions tab while recording | Current recording shows "● recording…" and can't be opened | ✅ |

## 3. Stop (parked)
| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Track → **■ Stop** | All three lines stay on the map | ✅ |
| 3.2 | Calibrate → **■ Stop recording** | Recording stops | ✅ |

## 4. Sessions list (M4)
| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | **Sessions** tab | New drive at the top of the list with duration, size, GPS fix count | ✅ |
| 4.2 | **↻ Refresh** | List updates with no duplicates | ✅ |

## 5. Replay (M4 + M5)
| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Open the drive | "Replaying sensor data…" then the map; opens at the end with **Wheel** selected | ✅ |
| 5.2 | Engine chips | ● PDR ● INS ● Wheel shown; no "no OBD speed" note | ✅ |
| 5.3 | Stats table | Rows for PDR, INS, Wheel plus GPS line with STEPS, FIXES, OBD > 0 | ✅ |
| 5.4 | Compare Wheel row to the live end values (1.7) | Distance and final error are close (small differences OK) | ✅ |
| 5.5 | Tap the bar near the start | Playhead jumps; lines are cut to that time | ✅ |
| 5.6 | **▶** at 1×, then 8×, then 32× | Clock advances at the right rate; lines grow; "err now" updates | ✅ |
| 5.7 | Let it play to the end | Stops on its own at the end; ▶ again restarts from the beginning | ✅ |
| 5.8 | Switch engines while paused | Error links and "err now" change to that engine | ✅ |
| 5.9 | **⌖ Fit** / **🔒 Lock** on the replay map | Same behaviour as on Track | ✅ |
| 5.10 | Open an older walking or stationary session | Only PDR and INS chips; "no OBD speed → no wheel"; opens on PDR | ✅ |
| 5.11 | Open a session recorded before M5 that had OBD connected | Wheel still appears (speeds read from old log lines) | ✅ |

## 6. Export (M4 + M5)
| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | Select Wheel → **Both** | Share sheet with `<id>.gpx` and `<id>-wheel-error.csv` | ✅ |
| 6.2 | Send to yourself and open the GPX (e.g. gpx.studio) | Tracks: GPS, PDR estimate, INS estimate, Wheel estimate, all with times | ✅ |
| 6.3 | Open the CSV | One row per second; err_m matches the Wheel error on screen | ✅ |
| 6.4 | Select PDR → **CSV** | File is `<id>-pdr-error.csv` | ✅ |
| 6.5 | Airplane mode → export again | Still works (no network needed) | ⏭ forgot airplane mode |

## 7. Offline replay
| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Airplane mode, close and reopen the app, open the drive | Replay and stats work; tiles load if the area was saved offline, otherwise the banner shows | ⏭ forgot airplane mode |

## 8. Delete
| # | Step | Expected | Result |
|---|---|---|---|
| 8.1 | Open a throwaway session → **Delete** → Cancel | Nothing deleted | ✅ |
| 8.2 | **Delete** → Delete | Back to the list; session gone | ✅ |

## 9. Bench checks (no car)
| # | Step | Expected | Result |
|---|---|---|---|
| 9.1 | Phone flat on a desk, Track → Start, INS selected, 2 min | "(still)" shows; INS distance stays near 0 | ✅ |
| 9.2 | Pick the phone up and move it around, then put it down | INS jumps, then stops moving once still again | ✅ |
| 9.3 | Short walk with PDR selected | PDR follows the walk; Wheel shows "—" with no OBD | ✅ |

## 10. If something fails
Stop the recording and use **Email** in Saved sessions to send it. Note the time it happened and which engine was selected.

## Notes / bugs found
- Driven 2026-11-11, recording `test/data/recordings/rec-2026-11-11T10-23-12`. Findings in `m4-m5-insights.md`.
