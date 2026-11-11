import React, {useRef, useState} from 'react';
import {
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  Text,
  View,
} from 'react-native';
import {BleManager, Characteristic, Device} from 'react-native-ble-plx';
import {Buffer} from 'buffer';
import {
  dlog,
  dlogError,
  fmtBytes,
  resetLog,
  saveDebugLog,
  shareDebugLog,
} from './debugLog';

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
    throw new Error('Bluetooth permission denied');
  }
}

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
  const pairs: {svc: string; w: Characteristic; n: Characteristic}[] = [];
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
          const v = r.value ? Buffer.from(r.value, 'base64').toString('latin1') : '';
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
      pairs.push({svc: s.uuid, w, n});
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
  return {write, notify};
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

export default function App() {
  const [log, setLog] = useState(
    'Tap the button with the dongle plugged in and ignition on.',
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const stopRef = useRef(false);
  const [live, setLive] = useState<{
    rpm?: number;
    kmh?: number;
    coolant?: number;
    cycles?: number;
  }>({});

  async function save() {
    try {
      const where = await saveDebugLog();
      setLog(l => `${l}\nDebug log saved to ${where}`);
    } catch (e: any) {
      setLog(l => `${l}\nSave failed: ${e?.message ?? e}`);
    }
  }

  async function share() {
    try {
      await shareDebugLog();
    } catch (e: any) {
      setLog(l => `${l}\nShare failed: ${e?.message ?? e}`);
    }
  }

  async function run() {
    setBusy(true);
    setFailed(false);
    resetLog();
    const out: string[] = [];
    const add = (s: string) => {
      dlog(`UI: ${s}`);
      out.push(s);
      setLog(out.join('\n'));
    };
    let device: Device | undefined;
    let disconnected = false;
    stopRef.current = false;
    setLive({});
    try {
      await requestPermissions();
      const state = await manager.state();
      dlog(`BLE state: ${state}`);
      if (state !== 'PoweredOn') {
        throw new Error(
          state === 'Unauthorized'
            ? 'Bluetooth permission denied. Allow it in Settings and try again.'
            : state === 'Unsupported'
            ? 'This phone does not support Bluetooth LE.'
            : 'Bluetooth is off. Turn on Bluetooth and try again.',
        );
      }
      add('Scanning...');
      device = await scanForDongle();
      add(`Found ${device.name ?? device.id}, connecting...`);
      device = await device.connect();
      dlog('Connected. Discovering services...');
      device.onDisconnected((e, d) => {
        disconnected = true;
        dlog(`Disconnected from ${d?.id}${e ? `: ${e.message}` : ''}`);
      });
      await device.discoverAllServicesAndCharacteristics();
      dlog(`MTU: ${device.mtu}`);
      const {write, notify} = await findChars(device);
      const send = makeSender(write, notify);

      // Every command is logged as "CMD <cmd> => <resp>"; failures don't abort.
      const q = async (cmd: string) => {
        try {
          const r = await send(cmd);
          dlog(`CMD ${cmd} => ${JSON.stringify(r)}`);
          return r;
        } catch (e) {
          dlogError(`cmd ${cmd}`, e);
          return '';
        }
      };

      for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']) {
        await q(c);
      }
      add('Adapter initialized.');

      dlog('=== ADAPTER INFO ===');
      for (const c of ['ATI', 'AT@1', 'AT@2', 'STI', 'STDI', 'ATRV']) {
        await q(c);
      }
      // First real request triggers protocol auto-detect.
      const sup0 = await q('0100');
      await q('ATDPN');
      add(`Protocol: ${(await q('ATDP')) || 'n/a'}`);

      dlog('=== ECU HEADERS (ATH1) ===');
      await q('ATH1');
      await q('0100');
      await q('0900');
      await q('ATH0');

      // Walk supported-PID bitmaps (mode 01 live, 02 freeze, 06 monitors, 09 info).
      const pidHex = (p: number) => p.toString(16).padStart(2, '0').toUpperCase();
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

      dlog('=== MODE 01 SUPPORTED ===');
      const live = await supported('01', sup0);
      dlog(`Mode 01 supported PIDs: ${live.map(pidHex).join(' ')}`);
      add(`Live PIDs supported: ${live.length}`);

      dlog('=== MODE 09 VEHICLE INFO ===');
      const info = await supported('09', await q('0900'));
      dlog(`Mode 09 supported: ${info.map(pidHex).join(' ')}`);
      for (const p of new Set([...info, 1, 2, 3, 4, 5, 6, 7, 8, 0x0a, 0x0b])) {
        await q('09' + pidHex(p));
      }

      dlog('=== DTCs ===');
      const dtcs = decodeDtcs(await q('03'));
      add(`Stored codes: ${dtcs.length ? dtcs.join(', ') : 'none'}`);
      await q('07'); // pending
      await q('0A'); // permanent

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

      // Continuous logging until Stop is tapped or the link drops.
      dlog('=== LIVE LOOP START ===');
      add('Logging live data. Drive! Tap Stop when done.');
      const allP = live.length ? live.map(pidHex) : ['0C', '0D', '05'];
      const fast = ['0C', '0D', '11', '04', '05', '0F', '10', '0B', '0E'].filter(
        p => live.includes(parseInt(p, 16)),
      );
      let cycle = 0;
      let lastSave = Date.now();
      while (!stopRef.current && !disconnected) {
        cycle++;
        const set = cycle % 10 === 1 || !fast.length ? allP : fast;
        dlog(`--- cycle ${cycle} (${set.length} PIDs) ---`);
        for (const p of set) {
          if (stopRef.current || disconnected) break;
          const r = await q('01' + p);
          const b = pidBytes(r, p);
          if (p === '0C' && b.length >= 2) {
            setLive(l => ({...l, rpm: (b[0] * 256 + b[1]) / 4}));
          } else if (p === '0D' && b.length) {
            setLive(l => ({...l, kmh: b[0]}));
          } else if (p === '05' && b.length) {
            setLive(l => ({...l, coolant: b[0] - 40}));
          }
        }
        setLive(l => ({...l, cycles: cycle}));
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
      add(`Done. ${cycle} cycles logged.`);
    } catch (e: any) {
      dlogError('run', e);
      add(`Error: ${e?.message ?? e}`);
      add('Tap "Email debug log" to send the details.');
      setFailed(true);
    } finally {
      await device?.cancelConnection().catch(() => {});
      try {
        const where = await saveDebugLog();
        out.push(`Log saved to ${where}`);
        setLog(out.join('\n'));
      } catch (e) {
        dlogError('final save', e);
      }
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{flex: 1, padding: 16}}>
      <Button
        title={busy ? 'Reading...' : 'Connect & Read'}
        onPress={run}
        disabled={busy}
      />
      {busy && (
        <View style={{marginTop: 8}}>
          <Button
            title="Stop & save"
            color="#c62828"
            onPress={() => {
              stopRef.current = true;
            }}
          />
          <Text style={{fontSize: 18, marginTop: 8}}>
            RPM {live.rpm ?? '-'} | {live.kmh ?? '-'} km/h | coolant{' '}
            {live.coolant ?? '-'} °C | cycles {live.cycles ?? 0}
          </Text>
        </View>
      )}
      <View style={{flexDirection: 'row', gap: 8, marginTop: 8}}>
        <View style={{flex: 1}}>
          <Button
            title="Save debug log"
            onPress={save}
            disabled={busy}
            color={failed ? '#c62828' : undefined}
          />
        </View>
        <View style={{flex: 1}}>
          <Button
            title="Email debug log"
            onPress={share}
            disabled={busy}
            color={failed ? '#c62828' : undefined}
          />
        </View>
      </View>
      <ScrollView style={{marginTop: 16}}>
        <Text style={{fontFamily: 'monospace'}}>{log}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
