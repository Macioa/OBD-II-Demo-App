"""Scrub private data from an OBD-II Demo App debug log in place.
Usage: python test/log_scrubber.py <log.txt>
"""
import re, sys, json

path = sys.argv[1]
src = open(path, encoding="utf-8", newline="").read()
lines = src.split("\n")

MARK = "REDACTED"

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

last_tx = None
out = []
for line in lines:
    orig = line
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

hdr = ("Sanitized: true -- private data replaced with REDACTED-* placeholders "
       "(VIN, calibration ID, CVN=DEADBEEF, in-use counters zeroed, phone identity, "
       "BLE names). MACs remapped to RFC 7042 documentation range 00:00:5E:00:53:xx "
       "(adapter = 00:00:5E:00:53:01). Live sensor/geolocation data untouched.")
out.insert(2, hdr)
open(path, "w", encoding="utf-8", newline="").write("\n".join(out))
print(json.dumps({"macs": mac_map, "names": name_map}, indent=1))
