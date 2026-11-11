"""Scrub private data from an OBD-II Demo App debug log in place.
Usage: python test/scripts/scrub_obd_log.py <log.txt> [<log.txt> ...]

Also importable: scrub_recording.py calls scrub_text() on the OBD lines that a
recording mirrors into events.log, and on the app-log.txt in emailed zips.
Already-sanitized files are skipped, so re-running is safe.
"""
import re, sys, json

MARK = "REDACTED"

HEADER = ("Sanitized: true -- private data replaced with REDACTED-* placeholders "
          "(VIN, calibration ID, CVN=DEADBEEF, in-use counters zeroed, phone identity, "
          "BLE names). MACs remapped to RFC 7042 documentation range 00:00:5E:00:53:xx "
          "(adapter = 00:00:5E:00:53:01). Live sensor/geolocation data untouched.")


# --- Mode 09 payload replacements (same byte length as originals)
def text_payload(s):
    return s.encode("ascii")


mode09 = {
    "0902": lambda L: text_payload("REDACTED-VIN-0000"[:L].ljust(L, "0")),
    "0904": lambda L: text_payload("REDACTED-CALID00"[:L].ljust(L, "0")),
    "0906": lambda L: bytes.fromhex("DEADBEEF" * ((L + 3) // 4))[:L],
    "0908": lambda L: bytes(L),
}


def rewrite_frames(pid, frames):
    # frames: list of hex strings. first: 49 PP NN + data ; rest: SEQ + data
    first_prefix, rest_prefix = 6, 2
    chunks = [frames[0][first_prefix:]] + [f[rest_prefix:] for f in frames[1:]]
    data = bytes.fromhex("".join(chunks))
    new = mode09[pid](len(data)).hex().upper()
    out, pos = [], 0
    for i, f in enumerate(frames):
        p = first_prefix if i == 0 else rest_prefix
        ln = len(f) - p
        out.append(f[:p] + new[pos:pos + ln])
        pos += ln
    return out


def unescape(s):
    return s.replace("\\r", "\r").replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")


ANCHOR_RE = re.compile(r"GPS anchor -?\d+\.\d+,\s*-?\d+\.\d+")


def scrub_text(src):
    """Return (scrubbed text, {"macs": ..., "names": ...}). Line count is preserved."""
    # --- MAC addresses -> RFC 7042 documentation range 00:00:5E:00:53:xx
    # adapter = device the app connected to (detected from the log, never hardcoded)
    _m = re.search(r"Disconnected from ((?:[0-9A-F]{2}:){5}[0-9A-F]{2})", src)
    macs = [_m.group(1)] if _m else []
    for m in re.findall(r"\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b", src):
        if m not in macs and m != "XX:XX:XX:XX:XX:XX":
            macs.append(m)
    mac_map = {m: "00:00:5E:00:53:%02X" % (i + 1) for i, m in enumerate(macs)}

    # --- BLE names
    _n = re.search(r"UI: Found (.+?), connecting", src)
    name_map = {_n.group(1): "REDACTED-ADAPTER-NAME"} if _n else {}
    n = 0
    for nm in re.findall(r" name=(.*?) localName=", src):
        if nm != "null" and nm not in name_map:
            n += 1
            name_map[nm] = "REDACTED-BLE-NAME-%02d" % n

    last_tx = None
    out = []
    for line in src.split("\n"):
        orig = line
        # Track screen logs its start fix ("track: GPS anchor lat,lon").
        line = ANCHOR_RE.sub("GPS anchor REDACTED", line)
        if line.startswith("Device: "):
            d = json.loads(line[8:])
            d["Brand"] = "REDACTED-PHONE-BRAND"
            d["Manufacturer"] = "REDACTED-PHONE-MFR"
            d["Model"] = "REDACTED-PHONE-MODEL"
            d["Fingerprint"] = "REDACTED-PHONE-FINGERPRINT"
            line = "Device: " + json.dumps(d, separators=(",", ":"))
        m = re.search(r' TX "([0-9A-F]+)\\r"', line)
        if m:
            last_tx = m.group(1)
        if last_tx in mode09:
            m = re.search(r' (RX|CMD [0-9A-F]+ =>) "(.*?)"', line)
            if m:
                sep = "\\r" if m.group(1) == "RX" else "\\n"
                body = m.group(2)
                tail = ""
                if body.endswith("\\r\\r>"):
                    tail, body = "\\r\\r>", body[:-5]
                frames = body.split(sep)
                if frames[0].startswith("49"):
                    body = sep.join(rewrite_frames(last_tx, frames)) + tail
                    line = line[:m.start(2)] + body + line[m.end(2):]
        # names first: some BLE names embed the MAC (e.g. DV2_<mac>)
        for k, v in sorted(name_map.items(), key=lambda kv: -len(kv[0])):
            line = line.replace(k, v)
        for k, v in mac_map.items():
            line = line.replace(k, v).replace(k.replace(":", ""), v.replace(":", ""))
        if line != orig:
            m = re.search(r'"((?:[^"\\]|\\.)*)" \[([0-9a-f ]*)\]$', line)
            if m:
                b = " ".join("%02x" % c for c in unescape(m.group(1)).encode("utf-8"))
                line = line[:m.start(2)] + b + line[m.end(2):]
        out.append(line)
    return "\n".join(out), {"macs": mac_map, "names": name_map}


def scrub_file(path):
    src = open(path, encoding="utf-8", newline="").read()
    if "\nSanitized: true" in src[:4000]:
        print(f"{path}: already sanitized, skipped")
        return
    text, maps = scrub_text(src)
    out = text.split("\n")
    out.insert(2, HEADER)
    open(path, "w", encoding="utf-8", newline="").write("\n".join(out))
    print(path)
    print(json.dumps(maps, indent=1))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        scrub_file(p)
