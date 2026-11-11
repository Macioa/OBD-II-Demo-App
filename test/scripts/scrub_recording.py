"""Scrub private data from an OBD App recording, in place.

Usage:
  python test/scripts/scrub_recording.py <session dir or emailed .zip> [...]
  python test/scripts/scrub_recording.py --anchor 51.4779,-0.0015 <session>

Input is either a session folder pulled from the phone (rec-YYYY-MM-DDTHH-MM-SS/)
or the emailed zip part(s). Zips are extracted next to themselves into
test/data/recordings/<session>/ first; pass all parts of one session together.

What is changed (and why the data stays useful):
  gps.csv      The whole track is moved to --anchor (default: Royal Observatory,
               Greenwich). Every fix keeps its exact east/north offset in metres
               from the first fix, so path shape, distances, speeds and bearings
               are unchanged and still line up with the IMU. Altitude becomes
               relative to the first fix. lat/lon at 1e-8 deg is ~1 mm.
  meta.json    Phone make/model and wall-clock timezone removed; start/stop times
               converted to UTC. Sensor chip details are kept (needed to judge noise).
  events.log   OBD lines get the same treatment as scrub_obd_log.py (VIN, cal IDs,
               adapter MAC and BLE names). Health lines are kept.
  app-log.txt  (emailed zips only) scrubbed with scrub_obd_log.py.
  imu_*.csv    Untouched: raw accel/gyro/rotation carry no location. The
               magnetometer field does loosely indicate the region of the
               world (field strength/dip angle) - documented, not altered,
               because changing it would break heading reconstruction.

A "sanitized" block is added to meta.json; already-sanitized sessions are skipped.
"""
import argparse, csv, io, json, math, os, re, sys, zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scrub_obd_log import scrub_text, HEADER as OBD_HEADER  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDINGS = os.path.normpath(os.path.join(HERE, "..", "data", "recordings"))
DEFAULT_ANCHOR = (51.4779, -0.0015)  # Royal Observatory, Greenwich
EARTH_R = 6378137.0  # WGS84 equatorial radius, m


def to_enu(lat, lon, lat0, lon0):
    """Local east/north metres from (lat0, lon0); exact enough for a few km."""
    e = math.radians(lon - lon0) * EARTH_R * math.cos(math.radians(lat0))
    n = math.radians(lat - lat0) * EARTH_R
    return e, n


def from_enu(e, n, lat0, lon0):
    lat = lat0 + math.degrees(n / EARTH_R)
    lon = lon0 + math.degrees(e / (EARTH_R * math.cos(math.radians(lat0))))
    return lat, lon


def scrub_gps(path, anchor):
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return {"fixes": 0}
    lat0, lon0 = float(rows[0]["lat"]), float(rows[0]["lon"])
    alt0 = float(rows[0]["alt"])
    max_err = 0.0
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=list(rows[0].keys()), lineterminator="\n")
    w.writeheader()
    for r in rows:
        e, n = to_enu(float(r["lat"]), float(r["lon"]), lat0, lon0)
        lat, lon = from_enu(e, n, *anchor)
        # Round-trip check: the moved point must sit at the same offset (mm).
        e2, n2 = to_enu(lat, lon, *anchor)
        max_err = max(max_err, math.hypot(e - e2, n - n2))
        r["lat"], r["lon"] = f"{lat:.8f}", f"{lon:.8f}"
        r["alt"] = f"{float(r['alt']) - alt0:.3f}"
        w.writerow(r)
    if max_err > 0.01:
        sys.exit(f"{path}: relocation error {max_err:.3f} m, refusing to write")
    open(path, "w", encoding="utf-8", newline="").write(out.getvalue())
    return {"fixes": len(rows), "maxOffsetErrorM": round(max_err, 6)}


def to_utc(stamp):
    try:
        return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%f%z") \
            .astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"
    except (TypeError, ValueError):
        return None


def scrub_meta(path, anchor, gps_info):
    meta = json.load(open(path, encoding="utf-8"))
    meta["device"] = {
        "manufacturer": "REDACTED-PHONE-MFR",
        "model": "REDACTED-PHONE-MODEL",
        "android": meta.get("device", {}).get("android"),
        "sdk": meta.get("device", {}).get("sdk"),
    }
    for k in ("startedAt", "stoppedAt"):
        if k in meta:
            meta[k] = to_utc(meta[k])
    meta["sanitized"] = {
        "by": "test/scripts/scrub_recording.py",
        "gps": f"track moved to anchor {anchor[0]},{anchor[1]}; metre offsets, "
               "speed and bearing preserved; altitude relative to first fix",
        "gpsFixes": gps_info.get("fixes", 0),
        "device": "make/model redacted; sensor chips kept",
        "times": "wall-clock converted to UTC",
        "events": "OBD lines scrubbed like scrub_obd_log.py",
        "notAltered": "imu_*.csv (magnetometer field loosely indicates world region)",
    }
    open(path, "w", encoding="utf-8").write(json.dumps(meta, indent=2) + "\n")


def scrub_events(path):
    src = open(path, encoding="utf-8", newline="").read()
    text, maps = scrub_text(src)
    open(path, "w", encoding="utf-8", newline="").write(text)
    return maps


def scrub_app_log(path):
    src = open(path, encoding="utf-8", newline="").read()
    if "\nSanitized: true" in src[:4000]:
        return
    text, _ = scrub_text(src)
    lines = text.split("\n")
    lines.insert(2, OBD_HEADER)
    open(path, "w", encoding="utf-8", newline="").write("\n".join(lines))


def extract_zips(zips):
    """Unpack emailed part zips into RECORDINGS; return the session folder(s)."""
    sessions = set()
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            for name in zf.namelist():
                top = name.split("/")[0]
                if not re.fullmatch(r"rec-[0-9T-]+", top) or ".." in name:
                    sys.exit(f"{z}: unexpected entry {name!r}")
                sessions.add(top)
            zf.extractall(RECORDINGS)
    return [os.path.join(RECORDINGS, s) for s in sorted(sessions)]


def scrub_session(d, anchor):
    meta_path = os.path.join(d, "meta.json")
    if not os.path.exists(meta_path):
        sys.exit(f"{d}: no meta.json - is this a recording folder?")
    if "sanitized" in json.load(open(meta_path, encoding="utf-8")):
        print(f"{d}: already sanitized, skipped")
        return
    gps_info = {}
    gps = os.path.join(d, "gps.csv")
    if os.path.exists(gps):
        gps_info = scrub_gps(gps, anchor)
    maps = {}
    ev = os.path.join(d, "events.log")
    if os.path.exists(ev):
        maps = scrub_events(ev)
    app = os.path.join(d, "app-log.txt")
    if os.path.exists(app):
        scrub_app_log(app)
    # meta last: its "sanitized" block marks the whole session as done.
    scrub_meta(meta_path, anchor, gps_info)
    print(d)
    print(json.dumps({"gps": gps_info, **maps}, indent=1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("inputs", nargs="+", help="session folder(s) or emailed zip part(s)")
    ap.add_argument("--anchor", default="%s,%s" % DEFAULT_ANCHOR,
                    help="lat,lon to move the track to (default Greenwich)")
    a = ap.parse_args()
    anchor = tuple(float(x) for x in a.anchor.split(","))
    zips = [p for p in a.inputs if p.lower().endswith(".zip")]
    dirs = [p for p in a.inputs if not p.lower().endswith(".zip")]
    for d in dirs + extract_zips(zips):
        scrub_session(d, anchor)


if __name__ == "__main__":
    main()
