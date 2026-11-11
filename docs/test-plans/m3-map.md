# M3 Map — Manual Test Plan (driving)

**Scope:** the M3 Track map during a drive: GPS path, map follow and zoom at road speeds, offline tiles over a drive-sized area, the error HUD, and recording/OBD staying alive across tab switches.

**Known gap: there is no driving estimate yet.** The only estimator is PDR (step counting), so in a car the orange "estimate" line will either sit at the start point or jump around on road bumps. The OBD wheel-speed estimate is milestone M5. For this test, judge only the map, the GPS line, recording and OBD. Treat the orange line and the ERROR/MAX/MEAN values as placeholders, and just note how they behave.

**Safety:** set everything up while parked. A passenger should operate the phone, or it should sit in a mount and not be touched while moving.

Mark each: ✅ pass · ❌ fail (note what happened) · ⏭ skipped.

## 0. Setup (parked, engine on)
| # | Step | Expected | Result |
|---|---|---|---|
| 0.1 | Phone online, location on, mounted in the car | — | ✅ |
| 0.2 | **Vehicle (OBD)** tab → connect to the 3210RS | Connects; RPM and km/h update | ✅ |
| 0.3 | **Calibrate** → **● Start recording** | REC shows; GPS fix count rises | ✅ |
| 0.4 | **Track** → **▶ Start PDR**, wait for a GPS fix | Map replaces the grid at your location | ✅ |
| 0.5 | Look at the map | Streets drawn, ⓘ attribution button, no MapLibre logo | ✅ |

## 1. Drive: GPS path and map
Plan a route of about 10–15 min with turns, a stop light, and some faster road (60+ km/h).

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Pull out and drive | Blue GPS line follows the roads you take | ✅ |
| 1.2 | Turns and a roundabout or U-turn | Line matches the turns; no big jumps across blocks | ✅ |
| 1.3 | Faster road | Map keeps zooming out so the whole trip stays visible; no stutter or freezing | ⏭ |
| 1.4 | Red light / stop | Line doesn't wander while stopped (small GPS jitter is OK) | ⏭ |
| 1.5 | Tunnel, overpass, or tall buildings if on the route | Note what the line does when GPS drops out | ⏭ |
| 1.6 | Track timer and DIST GPS | Timer counts up; GPS distance roughly matches the odometer | ✅ |
| 1.7 | Orange estimate line and STEPS (placeholder) | Note where it sits and what the step count does while driving | ❌ not visible |

## 2. Tab switches while driving (passenger only)
This regression already failed once in testing.

| # | Step | Expected | Result |
|---|---|---|---|
| 2.1 | Switch Track → Vehicle → Calibrate → Track a few times | Track still shows ◉ PDR with the timer running; blue line has no gap | ✅ |
| 2.2 | On Vehicle | OBD still connected; km/h matches the speedometer | ✅ |
| 2.3 | On Calibrate | REC still on; elapsed time and GPS fixes still rising | ✅ |
| 2.4 | Leave Vehicle open for 1+ min, then go back to Track | Path covers that minute | ✅ |

## 3. Map interaction (passenger only)
| # | Step | Expected | Result |
|---|---|---|---|
| 3.1 | Pan or zoom the map by hand | Auto-fit stops; **⌖ Fit** appears | ✅ |
| 3.2 | Keep driving for 30 s | Map stays where you left it | ✅ |
| 3.3 | Tap **⌖ Fit** | Map zooms back to the whole trip | ✅ |
| 3.4 | **Grid** then **Map** | Both views show the same trip; recording continues | ✅ |

## 4. GPS-denied mode (separate short drive, about 5 min)
| # | Step | Expected | Result |
|---|---|---|---|
| 4.1 | Parked: turn on **GPS-denied**, then Start | After the GPS fix the map shows no blue line and no grey error lines | ✅ |
| 4.2 | Drive | ERROR/MAX/MEAN show "—"; DIST GPS shows "hidden" | ✅ |
| 4.3 | Park, then tap **■ Stop** | The blue line for the whole drive appears | ✅ |

## 5. Stop and review (parked)
| # | Step | Expected | Result |
|---|---|---|---|
| 5.1 | Track → **■ Stop** | Paths stay on the map; timer stops | ✅ |
| 5.2 | Calibrate → **■ Stop recording** | Session appears in Saved sessions with its duration and GPS fix count | ✅ |
| 5.3 | Vehicle → disconnect | Disconnects cleanly | ✅ |

## 6. Offline tiles over the drive area
| # | Step | Expected | Result |
|---|---|---|---|
| 6.1 | After the drive, online, tap **⤓ Offline** on the map | "starting…" → % → "saved ✓" (covers the trip plus 1.5 km) | ✅ |
| 6.2 | Note how long it took and whether it finished | — | ✅ |
| 6.3 | Airplane mode, close and reopen the app, start on the same route | Streets load along the whole route from the saved area | ✅ |
| 6.4 | Airplane mode, somewhere off the saved area | Orange "Map tiles unavailable offline…" banner, or blank tiles; Grid still works | ✅ |

## 7. Long drive / stability (optional, 30+ min)
| # | Step | Expected | Result |
|---|---|---|---|
| 7.1 | Leave the Track map open for the whole drive | No crash; map stays responsive | ⏭ |
| 7.2 | Screen stays on (recording keeps it on) | Screen doesn't sleep | ⏭ |
| 7.3 | Phone temperature and battery drop | Note them | ⏭ |

## 8. If something fails
Stop the recording and use **Email** in Saved sessions to send it. Note the time it happened. `meta.json` → `stopReason` says why a recording ended.

## Notes / bugs found
-
