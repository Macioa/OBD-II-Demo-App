# How data is pulled from the OBD-II adapter

All logic is in [App.tsx](App.tsx).

## 1. The dongle
The OBD-II adapter has an **ELM327-compatible** chip inside. ELM327 is a text-based bridge: you send ASCII commands, and it talks to the car's OBD2 bus for you.

The 3210RS works with iPhones, and the manufacturer says to pair it inside the app, not in phone Bluetooth settings. Both point to **Bluetooth Low Energy (BLE)**, so the app uses `react-native-ble-plx`.

## 2. Connecting
1. Ask for Android Bluetooth permissions (`BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`, or location on Android 11 and older).
2. Scan for BLE devices for up to 15 s and pick the first one whose name contains `OBD` or `3210`.
3. Connect and discover all services.
4. Choose the first characteristic that is **writable** (for commands) and the first that is **notifiable** (for replies). No UUIDs are hardcoded, because the manufacturer does not publish them.

## 3. Talking to the ELM327
- Each command is ASCII text ending in `\r`, base64-encoded and written to the write characteristic.
- Replies arrive in chunks on the notify characteristic. The app buffers them until it sees the `>` prompt, which means the reply is complete.

Initialization:

| Command | Purpose |
|---|---|
| `ATZ`  | Reset |
| `ATE0` | Echo off |
| `ATL0` | Linefeeds off |
| `ATS0` | Spaces off |
| `ATSP0`| Auto-detect the car's OBD protocol |

## 4. Data requested

| Request | Meaning | Reply | Decoding |
|---|---|---|---|
| `03`   | Stored trouble codes | `43 ...` | Each 2-byte group is one code. The top 2 bits pick the letter (P/C/B/U), the next 2 bits the first digit, and the last 3 hex digits are the rest. Example: `0133` → `P0133`. On CAN cars the first byte is a count and is skipped. `0000` is padding. |
| `010C` | Engine RPM | `41 0C A B` | `(A*256 + B) / 4` |
| `010D` | Vehicle speed | `41 0D A` | `A` km/h |
| `0105` | Coolant temperature | `41 05 A` | `A - 40` °C |

Mode `01` replies start with `41` plus the PID, and mode `03` replies start with `43`. If the car doesn't reply (`NO DATA`), the value shows `n/a`.

## 5. Disconnect
The app always disconnects at the end so the dongle is free for the next read.
