# M4/M5 drive — insights from the data

**Data:** `test/data/recordings/rec-2026-11-11T10-23-12` (the M4/M5 test drive, 6:52, 2.79 km GPS), compared with the two earlier drives `rec-2026-11-11T07-18-40` (2:02, 0.77 km) and `rec-2026-11-11T08-51-52` (5:32, 2.35 km). OBD logs: `test/data/obd/obd-debug-2026-11-11T16-26-44-805Z.txt`, `…T16-30-07-619Z.txt`. All of it is scrubbed.

All figures below come from replaying the recordings through the app's own code (`replay()` / `runEngines()`).

## Engine results

| Drive | GPS dist | Engine | Est. dist | Final err | Max err | Mean err | Final err / dist |
|---|---|---|---|---|---|---|---|
| 10-23-12 (test drive) | 2793 m | **Wheel** | 2635 m | 129 m | 269 m | 156 m | **4.6 %** |
| | | INS | 3625 m | 792 m | 2340 m | 814 m | 28.3 % |
| | | PDR | 74 m | 19 m* | 846 m | 363 m | 0.7 %* |
| 08-51-52 | 2353 m | **Wheel** | 1865 m | 361 m | 361 m | 95 m | 15.3 % |
| | | INS | 1558 m | 1369 m | 1539 m | 886 m | 58.2 % |
| | | PDR | 45 m | 18 m* | 853 m | 391 m | 0.8 %* |
| 07-18-40 | 771 m | **Wheel** | 744 m | 273 m | 336 m | 225 m | 35.4 % |
| | | INS | 343 m | 297 m | 297 m | 136 m | 38.5 % |
| | | PDR | 14 m | 8 m* | 254 m | 127 m | 1.0 %* |

\* PDR's low final error is a fluke. The drives end near where they started and PDR never leaves the start. Its mean and max errors are the honest numbers.

**Wheel is the only usable car estimate.** On the test drive its mean error is less than half PDR's and a fifth of INS's.

## 1. OBD speed is accurate. Its gaps cost distance.
- Compared with GPS speed at the same moment, OBD speed is right on average: OBD/GPS ratio 1.003, mean difference +0.02 m/s. The other drives give 0.985 and 0.995.
- Even so, Wheel distance is 94 % of GPS (2635 of 2793 m). The loss comes from how often speed arrives:
  - Readings come every 1.1 s (median), but every ~10th poll cycle reads all 43 PIDs, which leaves 4.4 s gaps (95th percentile).
  - When the link dropped (287 s) there was a **20.3 s gap** (275–296 s) with no speed. That is longer than the 6 s stale limit, so the car counted as stopped for about 14 s.
  - Speed is held at the last reading (no interpolation) and OBD gives whole km/h.
- Next steps: poll PID 0D on every cycle (also during the full-PID cycles), interpolate the speed between readings on replay, and mark the gap on the path rather than treating the car as stopped.

## 2. Heading is the main error, and it's a fixed offset rather than noise
Compared with GPS bearing while moving (> 5 m/s, n = 290):

| Drive | Median signed error | Median abs. error | 90th percentile abs. error |
|---|---|---|---|
| 10-23-12 | **−18.9°** | 19.2° | 32.6° |
| 08-51-52 | +1.5° | 10.2° | 22.5° |
| 07-18-40 | **−33.4°** | 33.4° | 107° |

- The signed median is almost as large as the absolute one, so the path is rotated by a fixed angle rather than wobbling. The learned forward axis is off by about 19° on this drive.
- The axis is frozen after 40 speed-ups/brakes ("learned ×40"). On this drive that happened early in the trip, and any error then stays for the rest of the drive.
- Wheel error doesn't grow steadily with time: 151 / 262 / 207 / 129 m at 25 / 50 / 75 / 100 % of the drive. A rotated path drifts away and then comes back as the route loops.
- Next steps: keep refining the axis instead of freezing it, give more weight to hard speed-ups and brakes, and drop samples taken during turns (sideways acceleration skews it). The rotation vector's magnetometer can also be pulled off by the car's steel; a gyro-only heading after the start is worth testing.

## 3. INS: the speed reset now fires, but error still runs into kilometres
- The speed reset (ZUPT) fired **22 times** on this drive, against 0 on the 08-51-52 drive. The mount was probably steadier, so stops looked still.
- Error still reached 2.3 km max and grew with time (224 → 680 → 2098 m by quarter). Estimated distance was 3.6 km against 2.8 km real. This is the expected strapdown result, and it shows why wheel speed is needed.

## 4. PDR counts false steps in a car
- **115 "steps" in 412 s** of driving (the live run counted 107). The existing Jest check `driving: few false steps` allows fewer than 1 step per 4 s (≈ 103), so **that test now fails on this recording**. The earlier drives stayed under the limit.
- The steps add up to only 74 m, so the path barely moves, but PDR has to be off (or gated by OBD speed > 0) in a car.
- **Fixed:** PDR now ignores steps while OBD speed is above 0 km/h (reading less than 6 s old). On replay this drive drops from 115 to 11 steps (104 ignored), and the test passes again. The 11 left over happen while stopped or before OBD connected.

## 5. Live and replay agree
- Wheel distance at the live stop was 2634.3 m; replay gives 2635 m. The live and replay engines produce the same result.
- INS differs (live 3346 m, replay 3625 m) only because the live run started 38.5 s into the recording and replay starts at 0.

## 6. Recording and app health
- Sensors were steady for the whole 412 s: 513 accel/gyro/rot and ~500 mag samples per 5 s, max gap 10 ms, magnetometer accuracy 3 (high), 19–34 satellites, ~3.8 m GPS accuracy, no dropped rows.
- OBD reconnected by itself after the link loss: link lost at 287.0 s, logging again at 294.3 s, 7.3 s in total.
- There are ~40 "user moved map" events, mostly in bursts (e.g. 70–84 s). Each one pushes the 10 s recentering pause back, so during that stretch the map never recentered.

## Test plan items not covered
- 6.5 and 7.1 (airplane mode) were skipped.
