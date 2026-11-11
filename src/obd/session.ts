import { useSyncExternalStore } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Characteristic, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import {
  dlog,
  dlogError,
  fmtBytes,
  resetLog,
  saveDebugLog,
} from '../../debugLog';
import { logEvent } from '../sensors/imu';

/** An error that retrying can't fix (permissions, Bluetooth off). */
const fatal = (msg: string) => Object.assign(new Error(msg), { fatal: true });

const manager = new BleManager();
// Innova 3210RS advertises as "CodeReader31B" with service FFF0.
const NAME_MATCH = /obd|3210|codereader|innova/i;
const SERVICE_MATCH = /^0000fff0-/i;

async function requestPermissions() {
  if (Platform.OS !== 'android') return;
  const perms =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(perms);
  dlog(`Permissions (API ${Platform.Version}): ${JSON.stringify(res)}`);
  if (Object.values(res).some(r => r !== 'granted')) {
    throw fatal('Bluetooth permission denied');
  }
}

/** Devices that answered like something other than an ELM327 this session. */
const notObd = new Set<string>();
/** ATZ/ATI reply of a real adapter, e.g. "ELM327 v1.3a". */
export const ELM_ID = /ELM ?327|STN\d|OBD/i;

function scanForDongle(): Promise<Device> {
  const seen = new Set<string>();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.stopDeviceScan();
      dlog(
        `Scan timed out. ${seen.size} device(s) seen, none matched ${NAME_MATCH}`,
      );
      reject(new Error('OBD-II adapter not found (is ignition on?)'));
    }, 15000);
    manager.startDeviceScan(null, null, (err, dev) => {
      if (err) {
        dlog(`startDeviceScan failed (code ${err.errorCode})`);
        clearTimeout(timer);
        manager.stopDeviceScan();
        return reject(err);
      }
      if (dev && !seen.has(dev.id)) {
        seen.add(dev.id);
        dlog(
          `Scan saw id=${dev.id} name=${dev.name} localName=${dev.localName} ` +
            `rssi=${dev.rssi} services=${JSON.stringify(dev.serviceUUIDs)}`,
        );
      }
      if (
        dev &&
        !notObd.has(dev.id) &&
        (NAME_MATCH.test(dev.name ?? dev.localName ?? '') ||
          (dev.serviceUUIDs ?? []).some(u => SERVICE_MATCH.test(u)))
      ) {
        clearTimeout(timer);
        manager.stopDeviceScan();
        resolve(dev);
      }
    });
  });
}

// Find the UART-style write + notify characteristics the ELM327 uses.
async function findChars(device: Device) {
  let write: Characteristic | undefined;
  let notify: Characteristic | undefined;
  // Log the full GATT table (and read every readable char), then pick a
  // write+notify pair from the same service, preferring FFF0/FFE0 UART.
  const services = await device.services();
  const pairs: { svc: string; w: Characteristic; n: Characteristic }[] = [];
  for (const s of services) {
    dlog(`Service ${s.uuid}`);
    let w: Characteristic | undefined;
    let n: Characteristic | undefined;
    for (const c of await s.characteristics()) {
      dlog(
        `  Char ${c.uuid} writeResp=${c.isWritableWithResponse} ` +
          `writeNoResp=${c.isWritableWithoutResponse} notify=${c.isNotifiable} ` +
          `indicate=${c.isIndicatable} read=${c.isReadable}`,
      );
      if (c.isReadable) {
        try {
          const r = await c.read();
          const v = r.value
            ? Buffer.from(r.value, 'base64').toString('latin1')
            : '';
          dlog(`    read: ${fmtBytes(v)}`);
        } catch (e) {
          dlogError(`read ${c.uuid}`, e);
        }
      }
      try {
        for (const d of await c.descriptors()) {
          dlog(`    Desc ${d.uuid}`);
        }
      } catch {}
      if (!w && (c.isWritableWithResponse || c.isWritableWithoutResponse)) {
        w = c;
      }
      if (!n && (c.isNotifiable || c.isIndicatable)) {
        n = c;
      }
    }
    if (w && n) {
      pairs.push({ svc: s.uuid, w, n });
    }
  }
  const best =
    pairs.find(p => /^0000fff0-/i.test(p.svc)) ??
    pairs.find(p => /^0000ffe0-/i.test(p.svc)) ??
    pairs.find(p => !/^0000180[01]-/i.test(p.svc)) ??
    pairs[0];
  write = best?.w;
  notify = best?.n;
  if (!write || !notify) {
    throw new Error('No ELM327 characteristics found');
  }
  dlog(`Using write=${write.uuid} notify=${notify.uuid}`);
  return { write, notify };
}

// Sends one ELM327 command and resolves with the text before the '>' prompt.
function makeSender(write: Characteristic, notify: Characteristic) {
  let buf = '';
  let pending: ((s: string) => void) | null = null;
  notify.monitor((err, c) => {
    if (err) {
      dlogError('notify.monitor', err);
      return;
    }
    if (!c?.value) {
      return;
    }
    const chunk = Buffer.from(c.value, 'base64').toString('ascii');
    dlog(`RX ${fmtBytes(chunk)}`);
    buf += chunk;
    const i = buf.indexOf('>');
    if (i >= 0 && pending) {
      const out = buf.slice(0, i).replace(/\r/g, '\n').trim();
      buf = buf.slice(i + 1);
      const p = pending;
      pending = null;
      p(out);
    }
  });
  return (cmd: string) =>
    new Promise<string>((resolve, reject) => {
      pending = resolve;
      setTimeout(() => {
        if (pending === resolve) {
          pending = null;
          dlog(`TIMEOUT waiting for '>' after ${cmd}; buffer=${fmtBytes(buf)}`);
          reject(new Error(`Timeout: ${cmd}`));
        }
      }, 10000);
      dlog(`TX ${fmtBytes(cmd + '\r')}`);
      const b64 = Buffer.from(cmd + '\r', 'ascii').toString('base64');
      (write.isWritableWithResponse
        ? write.writeWithResponse(b64)
        : write.writeWithoutResponse(b64)
      ).catch(e => {
        dlogError(`write ${cmd}`, e);
        reject(e);
      });
    });
}

const hex = (s: string) => s.replace(/[^0-9A-F]/gi, '').toUpperCase();

function decodeDtcs(resp: string): string[] {
  const codes: string[] = [];
  for (const line of resp.split('\n')) {
    const h = hex(line);
    if (!h.startsWith('43')) {
      continue;
    }
    let data = h.slice(2);
    if (data.length % 4 === 2) {
      data = data.slice(2); // CAN responses include a DTC count byte
    }
    for (let i = 0; i + 4 <= data.length; i += 4) {
      const raw = data.slice(i, i + 4);
      if (raw === '0000') {
        continue;
      }
      const n = parseInt(raw, 16);
      codes.push('PCBU'[n >> 14] + ((n >> 12) & 3) + raw.slice(1));
    }
  }
  return codes;
}

function pidBytes(resp: string, pid: string): number[] {
  const h = hex(resp);
  const i = h.indexOf('41' + pid);
  if (i < 0) {
    return [];
  }
  return (h.slice(i + 4).match(/../g) ?? []).map(b => parseInt(b, 16));
}

// ---------------------------------------------------------------------------
// Session: one OBD connection for the whole app. Lives outside any screen so
// tab switches can't touch it; screens subscribe to its state.

export type ObdStatus =
  | 'idle'
  | 'connecting'
  | 'reading'
  | 'reconnecting'
  | 'error';

export type ObdLive = {
  rpm?: number;
  kmh?: number;
  coolant?: number;
  cycles?: number;
};

export type ObdState = {
  status: ObdStatus;
  /** What it's doing right now ("Scanning…", "Initializing adapter…"). */
  step: string;
  /** User-facing progress lines. */
  log: string[];
  live: ObdLive;
  /** Why it stopped (error) or how it ended (idle after a run). */
  message?: string;
  attempt: number;
  failed: boolean;
};

export const MAX_RECONNECTS = 3;
/** Tunables (tests shrink the backoff). */
export const obdConfig = { reconnectBaseMs: 2000 };
/** Backoff before reconnect attempt n (1-based), ms: 2 s, 4 s, 8 s. */
export const reconnectDelay = (n: number) =>
  obdConfig.reconnectBaseMs * 2 ** (n - 1);

let state: ObdState = {
  status: 'idle',
  step: '',
  log: ['Tap Connect & Read with the dongle plugged in and ignition on.'],
  live: {},
  attempt: 0,
  failed: false,
};
const listeners = new Set<() => void>();

function set(patch: Partial<ObdState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}
function say(line: string) {
  dlog(`UI: ${line}`);
  set({ log: [...state.log, line] });
}
function setLive(f: (l: ObdLive) => ObdLive) {
  set({ live: f(state.live) });
}

export const getObd = () => state;

/** M5: each vehicle-speed reading (km/h) as it arrives, for the wheel engine. */
const speedListeners = new Set<(kmh: number) => void>();
export function onObdSpeed(cb: (kmh: number) => void) {
  speedListeners.add(cb);
  return () => {
    speedListeners.delete(cb);
  };
}
export function subscribeObd(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let stopReq = false;
let current: Device | undefined;
/** Supported mode-01 PIDs from the first connect; reconnects skip the probe. */
let livePids: number[] | null = null;
const sleep = (ms: number) =>
  new Promise<void>(res => {
    const until = Date.now() + ms;
    const tick = () =>
      stopReq || Date.now() >= until
        ? res()
        : setTimeout(tick, Math.min(200, until - Date.now()));
    tick();
  });

const pidHex = (p: number) => p.toString(16).padStart(2, '0').toUpperCase();

/** Ends the session after the current command. Safe in any state. */
export function stopObd() {
  if (state.status === 'idle' || state.status === 'error') {
    return;
  }
  dlog('OBD stop requested by user');
  stopReq = true;
  manager.stopDeviceScan();
  if (state.status !== 'reading') {
    // Abort a scan/connect/probe in progress.
    current?.cancelConnection().catch(() => {});
  }
}

/**
 * Connects and reads until stopObd(). A dropped link is retried
 * MAX_RECONNECTS times with backoff before giving up with an error.
 */
export async function startObd() {
  if (state.status !== 'idle' && state.status !== 'error') {
    return;
  }
  stopReq = false;
  resetLog();
  set({
    status: 'connecting',
    step: 'Starting…',
    log: [],
    live: {},
    message: undefined,
    attempt: 0,
    failed: false,
  });
  let attempt = 0;
  let lastErr = '';
  let everRead = false;
  while (!stopReq) {
    try {
      await connectAndRead(attempt > 0, () => {
        everRead = true;
        attempt = 0; // a working cycle resets the retry budget
        if (state.attempt) {
          set({ attempt: 0 });
        }
      });
      break; // returned normally = stopped by user
    } catch (e: any) {
      if (stopReq) {
        break;
      }
      lastErr = String(e?.message ?? e);
      dlogError('obd session', e);
      attempt++;
      if (e?.fatal || attempt > MAX_RECONNECTS) {
        say(`Error: ${lastErr}`);
        say('Tap "Email debug log" to send the details.');
        set({
          status: 'error',
          step: '',
          message: e?.fatal
            ? lastErr
            : `${lastErr} (gave up after ${MAX_RECONNECTS} ${
                everRead ? 'reconnects' : 'retries'
              })`,
          failed: true,
        });
        await finish();
        return;
      }
      const wait = reconnectDelay(attempt);
      const what = everRead ? 'Reconnecting' : 'Retrying';
      say(
        `${everRead ? 'Link lost' : 'Failed'}: ${lastErr}. ` +
          `${what} in ${wait / 1000} s…`,
      );
      set({
        status: 'reconnecting',
        step: `${what} (${attempt}/${MAX_RECONNECTS})…`,
        attempt,
      });
      await sleep(wait);
    }
  }
  const cycles = state.live.cycles ?? 0;
  say(`Stopped. ${cycles} cycles logged.`);
  set({
    status: 'idle',
    step: '',
    message: `Stopped after ${cycles} cycles`,
  });
  await finish();
}

async function finish() {
  try {
    const where = await saveDebugLog();
    say(`Log saved to ${where}`);
  } catch (e) {
    dlogError('final save', e);
  }
}

async function connectAndRead(reconnect: boolean, onCycle: () => void) {
  let device: Device | undefined;
  let disconnected: string | null = null;
  const step = (s: string) => {
    if (state.status !== 'reconnecting') {
      set({ status: 'connecting', step: s });
    } else {
      set({ step: `Reconnecting: ${s}` });
    }
  };
  try {
    await requestPermissions();
    const bt = await manager.state();
    dlog(`BLE state: ${bt}`);
    if (bt !== 'PoweredOn') {
      throw fatal(
        bt === 'Unauthorized'
          ? 'Bluetooth permission denied. Allow it in Settings and try again.'
          : bt === 'Unsupported'
          ? 'This phone does not support Bluetooth LE.'
          : 'Bluetooth is off. Turn on Bluetooth and try again.',
      );
    }
    step('Scanning…');
    say('Scanning...');
    device = await scanForDongle();
    current = device;
    step('Connecting…');
    say(`Found ${device.name ?? device.id}, connecting...`);
    device = await device.connect();
    current = device;
    dlog('Connected. Discovering services...');
    device.onDisconnected((e, d) => {
      disconnected = e?.message ?? 'disconnected';
      dlog(`Disconnected from ${d?.id}${e ? `: ${e.message}` : ''}`);
    });
    await device.discoverAllServicesAndCharacteristics();
    dlog(`MTU: ${device.mtu}`);
    const { write, notify } = await findChars(device);
    const send = makeSender(write, notify);

    // Every command is logged as "CMD <cmd> => <resp>"; failures don't abort.
    const q = async (cmd: string) => {
      if (disconnected) {
        throw new Error(`Link lost (${disconnected})`);
      }
      try {
        const r = await send(cmd);
        dlog(`CMD ${cmd} => ${JSON.stringify(r)}`);
        return r;
      } catch (e) {
        dlogError(`cmd ${cmd}`, e);
        if (disconnected) {
          throw new Error(`Link lost (${disconnected})`);
        }
        return '';
      }
    };

    step('Initializing adapter…');
    // Other gadgets share the FFF0 UART service; only talk on if it's an ELM.
    const id = await q('ATZ');
    if (!ELM_ID.test(id) && !ELM_ID.test(await q('ATI'))) {
      notObd.add(device.id);
      dlog(`${device.name ?? device.id} is not an ELM327 (ATZ="${id}")`);
      throw new Error(`${device.name ?? 'Device'} is not an OBD-II adapter`);
    }
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) {
      await q(c);
    }
    say('Adapter initialized.');

    if (!reconnect || !livePids) {
      livePids = await probe(q, step);
    } else {
      await q('0100'); // protocol auto-detect
    }
    const live = livePids;

    // Continuous logging until Stop is tapped or the link drops.
    dlog('=== LIVE LOOP START ===');
    say('Logging live data. Tap Stop when done.');
    set({ status: 'reading', step: '', attempt: 0 });
    const allP = live.length ? live.map(pidHex) : ['0C', '0D', '05'];
    const fast = ['0C', '0D', '11', '04', '05', '0F', '10', '0B', '0E'].filter(
      p => live.includes(parseInt(p, 16)),
    );
    let cycle = state.live.cycles ?? 0;
    let lastSave = Date.now();
    let n = 0;
    while (!stopReq) {
      cycle++;
      n++;
      const set_ = n % 10 === 1 || !fast.length ? allP : fast;
      dlog(`--- cycle ${cycle} (${set_.length} PIDs) ---`);
      for (const p of set_) {
        if (stopReq) {
          break;
        }
        const r = await q('01' + p);
        const b = pidBytes(r, p);
        if (p === '0C' && b.length >= 2) {
          setLive(l => ({ ...l, rpm: (b[0] * 256 + b[1]) / 4 }));
        } else if (p === '0D' && b.length) {
          setLive(l => ({ ...l, kmh: b[0] }));
          logEvent(`obd kmh=${b[0]}`);
          speedListeners.forEach(cb => cb(b[0]));
        } else if (p === '05' && b.length) {
          setLive(l => ({ ...l, coolant: b[0] - 40 }));
        }
      }
      setLive(l => ({ ...l, cycles: cycle }));
      onCycle();
      if (cycle % 20 === 0) {
        await q('ATRV');
        await q('03');
      }
      if (Date.now() - lastSave > 180000) {
        lastSave = Date.now();
        await saveDebugLog().then(
          w => dlog(`Autosaved to ${w}`),
          e => dlogError('autosave', e),
        );
      }
    }
    dlog(`=== LIVE LOOP END after ${cycle} cycles ===`);
  } finally {
    current = undefined;
    await device?.cancelConnection().catch(() => {});
  }
}

type Q = (cmd: string) => Promise<string>;

/** Full first-connect probe: adapter info, supported PIDs, VIN, DTCs, etc. */
async function probe(q: Q, step: (s: string) => void): Promise<number[]> {
  step('Reading adapter info…');
  dlog('=== ADAPTER INFO ===');
  for (const c of ['ATI', 'AT@1', 'AT@2', 'STI', 'STDI', 'ATRV']) {
    await q(c);
  }
  // First real request triggers protocol auto-detect.
  const sup0 = await q('0100');
  await q('ATDPN');
  say(`Protocol: ${(await q('ATDP')) || 'n/a'}`);

  dlog('=== ECU HEADERS (ATH1) ===');
  await q('ATH1');
  await q('0100');
  await q('0900');
  await q('ATH0');

  // Walk supported-PID bitmaps (mode 01 live, 02 freeze, 06 monitors, 09 info).
  const supported = async (mode: string, first: string, suffix = '') => {
    const pids: number[] = [];
    let base = 0;
    let resp = first;
    const respMode = pidHex(parseInt(mode, 16) + 0x40);
    while (true) {
      const h = hex(resp);
      const i = h.indexOf(respMode + pidHex(base));
      if (i < 0) break;
      const bits = parseInt(h.slice(i + 4, i + 12), 16) >>> 0;
      if (isNaN(bits)) break;
      for (let b = 0; b < 32; b++) {
        if (bits & (1 << (31 - b))) pids.push(base + b + 1);
      }
      if (!(bits & 1) || base >= 0xe0) break;
      base += 0x20;
      resp = await q(mode + pidHex(base) + suffix);
    }
    return pids.filter(p => p % 0x20 !== 0);
  };

  step('Reading supported PIDs…');
  dlog('=== MODE 01 SUPPORTED ===');
  const live = await supported('01', sup0);
  dlog(`Mode 01 supported PIDs: ${live.map(pidHex).join(' ')}`);
  say(`Live PIDs supported: ${live.length}`);

  step('Reading vehicle info…');
  dlog('=== MODE 09 VEHICLE INFO ===');
  const info = await supported('09', await q('0900'));
  dlog(`Mode 09 supported: ${info.map(pidHex).join(' ')}`);
  for (const p of new Set([...info, 1, 2, 3, 4, 5, 6, 7, 8, 0x0a, 0x0b])) {
    await q('09' + pidHex(p));
  }

  step('Reading trouble codes…');
  dlog('=== DTCs ===');
  const dtcs = decodeDtcs(await q('03'));
  say(`Stored codes: ${dtcs.length ? dtcs.join(', ') : 'none'}`);
  await q('07'); // pending
  await q('0A'); // permanent

  step('Reading freeze frame & monitors…');
  dlog('=== MODE 02 FREEZE FRAME ===');
  const ff = await supported('02', await q('020000'), '00');
  dlog(`Mode 02 supported: ${ff.map(pidHex).join(' ')}`);
  for (const p of ff) await q('02' + pidHex(p) + '00');

  dlog('=== MODE 06 MONITOR RESULTS ===');
  const mon = await supported('06', await q('0600'));
  dlog(`Mode 06 supported: ${mon.map(pidHex).join(' ')}`);
  for (const p of mon) await q('06' + pidHex(p));

  dlog('=== MODE 01 ONE-SHOT (all supported) ===');
  for (const p of live) await q('01' + pidHex(p));
  return live;
}

/** React hook: current OBD session state, re-rendering on change. */
export function useObd(): ObdState {
  return useSyncExternalStore(subscribeObd, getObd);
}
