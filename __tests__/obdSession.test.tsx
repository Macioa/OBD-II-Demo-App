/**
 * R2 (docs/plans/m3-revision.md): the OBD session keeps reading across tab
 * switches, stops only on Stop, reconnects after a dropped link and shows an
 * error only when reconnecting fails.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

// ---- Fake ELM327 dongle over BLE -------------------------------------------
const mockDongle = {
  bt: 'PoweredOn',
  gone: false, // connect() fails while true
  connects: 0,
  /** Name of a non-OBD FFF0 gadget seen first in the next scan. */
  impostor: null as null | string,
  dropLink: null as null | (() => void),
};
const mockElm: Record<string, string> = {
  ATZ: 'ELM327 v1.3a',
  '0100': '410008180000', // PIDs 05, 0C, 0D
  '010C': '410C0DB9',
  '010D': '410D32', // 50 km/h
  '0105': '41057C',
};

jest.mock('react-native-ble-plx', () => {
  const { Buffer } = require('buffer');
  const mkDevice = () => {
    let onRx: ((e: unknown, c: { value: string }) => void) | null = null;
    let onDisc: ((e: { message: string } | null, d: unknown) => void) | null =
      null;
    const notify = {
      uuid: 'n',
      isNotifiable: true,
      isReadable: false,
      descriptors: async () => [],
      monitor: (cb: typeof onRx) => {
        onRx = cb;
      },
    };
    const write = {
      uuid: 'w',
      isWritableWithResponse: true,
      isReadable: false,
      descriptors: async () => [],
      writeWithResponse: async (b64: string) => {
        const cmd = Buffer.from(b64, 'base64').toString('ascii').trim();
        const r = dev.silent
          ? '?'
          : mockElm[cmd] ?? (cmd.startsWith('AT') ? 'OK' : 'NO DATA');
        setTimeout(() =>
          onRx?.(null, {
            value: Buffer.from(`${r}\r\r>`, 'ascii').toString('base64'),
          }),
        );
      },
    };
    const dev: any = {
      id: 'AA',
      name: 'CodeReader31B',
      mtu: 23,
      connect: async () => {
        if (mockDongle.gone) {
          throw new Error('connect failed');
        }
        mockDongle.connects++;
        mockDongle.dropLink = () => onDisc?.({ message: 'peer closed' }, dev);
        return dev;
      },
      onDisconnected: (cb: typeof onDisc) => {
        onDisc = cb;
      },
      discoverAllServicesAndCharacteristics: async () => dev,
      services: async () => [
        { uuid: '0000fff0-x', characteristics: async () => [write, notify] },
      ],
      cancelConnection: async () => dev,
    };
    return dev;
  };
  return {
    BleManager: class {
      state = async () => mockDongle.bt;
      startDeviceScan = (_a: unknown, _b: unknown, cb: Function) =>
        setTimeout(() => {
          if (mockDongle.impostor) {
            const fake = mkDevice();
            fake.id = 'BB';
            fake.name = mockDongle.impostor;
            fake.silent = true;
            fake.serviceUUIDs = ['0000fff0-0000-1000-8000-00805f9b34fb'];
            cb(null, fake);
          }
          cb(null, mkDevice());
        });
      stopDeviceScan = () => {};
    },
  };
});
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

// Sensor module stand-in so the Calibrate/Recording screens mount quietly.
require('react-native').NativeModules.ImuSensors = {
  getAvailability: async () => ({}),
  start: async () => 4,
  stop: async () => true,
  listRecordings: async () => [],
  logEvent: () => {},
  addListener: () => {},
  removeListeners: () => {},
};

const session = require('../src/obd/session');
const seen: string[] = [];
session.subscribeObd(() => {
  const s = session.getObd().status;
  if (seen[seen.length - 1] !== s) {
    seen.push(s);
  }
});
const App = require('../App').default;
session.obdConfig.reconnectBaseMs = 5;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(
        `timed out; status=${st().status} cycles=${
          st().live.cycles
        } seen=${seen}`,
      );
    }
    await act(async () => {
      await new Promise(r => setTimeout(r, 5));
    });
  }
};
const st = () => session.getObd();

type Inst = ReactTestRenderer.ReactTestInstance;
function textOf(n: Inst | string): string {
  return typeof n === 'string' ? n : n.children.map(textOf).join('');
}
function press(r: ReactTestRenderer.ReactTestRenderer, label: RegExp) {
  const hits = r.root.findAll(
    x =>
      typeof x.props.onPress === 'function' &&
      label.test(textOf(x).trim().toLowerCase()),
  );
  expect(hits.length).toBeGreaterThan(0);
  hits[hits.length - 1].props.onPress();
}

beforeEach(async () => {
  Object.assign(mockDongle, {
    bt: 'PoweredOn',
    gone: false,
    connects: 0,
    impostor: null,
  });
  if (st().status !== 'idle' && st().status !== 'error') {
    session.stopObd();
    await until(() => st().status === 'idle');
  }
});

test('reads through tab switches until Stop; green state + badge', async () => {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(<App />);
  });
  await act(async () => press(r, /^vehicle/));
  await act(async () => press(r, /^connect & read$/));
  await until(() => st().status === 'reading' && st().live.cycles > 2);

  const main = () => r.root.findAll(x => x.props.testID === 'obd-main')[0];
  expect(textOf(main())).toMatch(/Reading/);
  expect([main().props.style].flat(3)).toContainEqual({
    backgroundColor: '#2e7d32',
  });
  expect(
    r.root.findAll(x => x.props.testID === 'obd-stop').length,
  ).toBeGreaterThan(0);

  for (let i = 0; i < 3; i++) {
    for (const tab of [/^track/, /^calibrate/, /^vehicle/]) {
      await act(async () => press(r, tab));
      const c = st().live.cycles;
      await until(() => st().live.cycles > c); // keeps polling
    }
  }
  expect(st().status).toBe('reading');
  expect(st().live.kmh).toBe(50);
  const badge = r.root.findAll(x => x.props.testID === 'obd-badge')[0];
  expect(textOf(badge)).toMatch(/50 km\/h/);

  await act(async () => press(r, /^■ stop$/));
  await until(() => st().status === 'idle');
  expect(st().message).toMatch(/Stopped after \d+ cycles/);
  expect(textOf(main())).toMatch(/Connect & Read/);
  await act(async () => r.unmount());
});

test('dropped link reconnects and keeps reading', async () => {
  session.startObd();
  await until(() => st().status === 'reading' && st().live.cycles >= 2);
  const c = st().live.cycles;
  seen.length = 0;
  mockDongle.dropLink!();
  await until(() => st().status === 'reading' && st().live.cycles > c + 1);
  expect(seen.filter(x => x !== 'reading')).toEqual(['reconnecting']);
  expect(seen[seen.length - 1]).toBe('reading');
  expect(mockDongle.connects).toBe(2);
  session.stopObd();
  await until(() => st().status === 'idle');
});

test('dongle gone: gives up after 3 reconnects with a red error', async () => {
  session.startObd();
  await until(() => st().status === 'reading' && st().live.cycles >= 1);
  mockDongle.gone = true;
  mockDongle.dropLink!();
  await until(() => st().status === 'error');
  expect(st().message).toMatch(/gave up after 3 reconnects/);
  expect(st().failed).toBe(true);
});

test('skips a non-OBD FFF0 device and connects to the real dongle', async () => {
  mockDongle.impostor = 'My_Gadget';
  session.startObd();
  await until(() => st().status === 'reading' && st().live.cycles > 1);
  expect(st().log.join(' | ')).toMatch(/My_Gadget is not an OBD-II adapter/);
  expect(st().log.join(' | ')).toMatch(/Found CodeReader31B/);
  session.stopObd();
  await until(() => st().status === 'idle');
});

test('Bluetooth off fails at once without retrying', async () => {
  mockDongle.bt = 'PoweredOff';
  session.startObd();
  await until(() => st().status === 'error');
  expect(st().message).toMatch(/Bluetooth is off/);
  expect(st().log.join('\n')).not.toMatch(/Reconnecting/);
});

afterAll(async () => {
  session.stopObd();
  await until(() => st().status === 'idle' || st().status === 'error');
});
