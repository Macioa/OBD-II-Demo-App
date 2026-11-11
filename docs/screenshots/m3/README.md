# M3 screenshots — offline map and M3 revision

Taken 2026-11-11 on the test phone. Status and navigation bars cropped.

**Privacy:** map tiles are pixelated so street names and building shapes
can't be read. The app's own overlays (orange estimate ring, blue GPS path)
and the map buttons are left sharp. A third-party Bluetooth device's name is
greyed out in the OBD log text.

| File | Shows |
|---|---|
| `01-grid-before-fix.png` | Map selected but no GPS fix yet: falls back to the grid with a hint |
| `02-map-live.png` | PDR running on the map: estimate ring, Fit / Lock / Offline buttons, error HUD (current, max, mean) |
| `03-recenter-paused.png` | Map dragged by hand: position off the top edge, recentering paused for 10 s |
| `04-recentered.png` | 10 s later: map recentered on the position at the same zoom; blue GPS path visible |
| `05-locked.png` | 🔒 Locked: map dragged and left for 14 s, no recentering |
| `06-fit-while-locked.png` | ⌖ Fit while locked: fits the trip once, lock stays on |
| `07-offline-saved.png` | ⤓ Offline: tile pack for the trip + 1.5 km saved |
| `08-gps-denied-running.png` | GPS-denied on: GPS line, error lines and error figures hidden ("GPS hidden", "—") |
| `09-gps-denied-revealed.png` | After Stop: GPS distance and error figures revealed |
| `10-obd-badge-on-track.png` | OBD status badge under the Vehicle tab while on Track (here: reconnecting) |
| `11-obd-idle.png` | Vehicle tab idle: blue Connect & Read |
| `12-obd-connecting.png` | Connecting: amber button with the current step, red Cancel, badge "connecting" |
| `13-obd-error.png` | Dongle not found after 3 retries: red Reconnect with the reason, badge "error" |

Not captured: the green "● Reading — cycle N" state with live RPM/km/h (needs the
car's dongle in range; covered by `__tests__/obdSession.test.tsx`), and the
"tiles unavailable offline" banner (needs airplane mode).
