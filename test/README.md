# test/

```
test/
├── scripts/
│   ├── scrub_obd_log.py      remove private data from an OBD debug log
│   └── scrub_recording.py    remove private data from a sensor/GPS recording
└── data/
    ├── obd/                  obd-debug-<UTC time>.txt   (from the Vehicle tab)
    └── recordings/           rec-<local time>/           (from the Calibrate tab)
        ├── meta.json         device, sensors, start/stop, calibration
        ├── imu_000.csv …     t,s,x,y,z,w  raw accel/gyro/mag/quaternion, 10 min per file
        ├── gps.csv           t,lat,lon,alt,acc,speed,bearing,sats  (1 Hz)
        ├── events.log        app + OBD events and 5 s sensor health lines
        └── app-log.txt       only in emailed zips: the full app debug log
```

Jest unit tests live in `__tests__/` at the repo root; this folder holds the
recorded data they and future tests replay, plus tools.

## Adding data — always scrub before committing

Everything in `data/` is meant to be committed, so **scrub first**. Both
scripts edit in place, skip files they have already done, and need only Python 3.

### OBD log

```bash
adb pull /sdcard/Download/obd-debug-<time>.txt test/data/obd/
python test/scripts/scrub_obd_log.py test/data/obd/obd-debug-<time>.txt
```

Replaces the VIN, calibration IDs/CVNs, in-use counters, phone identity, BLE
device names and MAC addresses. Live vehicle data is kept.

### Recording

From the phone over USB:

```bash
adb pull /sdcard/Android/data/com.obdiidemoapp/files/recordings/rec-<time> test/data/recordings/
python test/scripts/scrub_recording.py test/data/recordings/rec-<time>
```

Or from the emailed zip part(s), passing all parts of one session together
(they are unpacked into `data/recordings/` first):

```bash
python test/scripts/scrub_recording.py ~/Downloads/rec-<time>_part1.zip ~/Downloads/rec-<time>_part2.zip
```

What changes:

| File | Scrubbing |
|---|---|
| `gps.csv` | Track moved to a neutral spot (default Royal Observatory, Greenwich; `--anchor lat,lon` to change). Each fix keeps its exact metre offset from the first fix, so shape, distance, speed and bearing are unchanged and still line up with the IMU. Altitude becomes relative to the first fix. |
| `meta.json` | Phone make/model redacted; times converted to UTC (drops the timezone). A `sanitized` block records what was done. |
| `events.log`, `app-log.txt` | OBD lines scrubbed exactly like `scrub_obd_log.py`. |
| `imu_*.csv` | Not changed. The magnetometer field strength and dip loosely indicate the region of the world; altering it would break heading reconstruction. |

Check before committing that nothing identifying is left, e.g.:

```bash
grep -rn "<your street or town>" test/data
```
