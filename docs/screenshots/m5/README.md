# M5 screenshots — INS + Wheel engines and comparison overlay

Taken 2026-11-11 on the test phone, on the current build (includes the PDR-ignores-steps-while-OBD-moving fix). Status and navigation bars cropped.

**Privacy:** map tiles are pixelated so street names and building shapes
can't be read. The app's overlays (blue GPS, green Wheel, purple INS, orange
PDR) are left sharp on the drive; on the stationary and live shots only the
orange ring is kept.

| File | Shows |
|---|---|
| `01-replay-wheel.png` | 6:52 test drive replayed with **Wheel** selected: green dashed estimate vs blue GPS, error links, stats for all three engines (Wheel 2635 m, mean 156 m, 4.6 %) |
| `02-replay-ins.png` | Same drive with **INS** selected: purple estimate drifts off the map (mean 814 m) |
| `03-replay-pdr.png` | **PDR** selected: estimate stays near the start; STEPS 11 after the OBD gating fix (was 115) |
| `04-replay-scrubbed.png` | Scrubbed to 2:23 with Wheel: all lines cut at the playhead, err now 195.6 m |
| `05-replay-no-obd.png` | 0:51 stationary session with no OBD: only PDR and INS chips, "no OBD speed → no wheel" |
| `06-track-three-engines.png` | Live Track at rest: legend GPS / PDR / INS / Wheel, INS "(still)", "OBD idle (wheel needs OBD)", AXIS — |

Not captured: live Wheel in a car with AXIS "learned ×N" (needs a drive with the dongle).
