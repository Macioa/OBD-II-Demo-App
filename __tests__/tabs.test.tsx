/**
 * Regression: switching tabs must not stop the sensor stream, the session
 * recording, or the Track PDR run (all screens stay mounted, only hidden).
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';

type Listener = (e: unknown) => void;
const mockListeners = new Set<Listener>();
const native = {
  getAvailability: jest.fn().mockResolvedValue({
    acc: null,
    gyr: null,
    mag: null,
    rot: null,
  }),
  start: jest.fn().mockResolvedValue(4),
  stop: jest.fn().mockResolvedValue(true),
  startRecording: jest.fn().mockResolvedValue('rec-test'),
  stopRecording: jest.fn().mockResolvedValue('rec-test'),
  logEvent: jest.fn(),
  listRecordings: jest.fn().mockResolvedValue([]),
  shareRecording: jest.fn(),
  deleteRecording: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
NativeModules.ImuSensors = native;

jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => ({
  __esModule: true,
  default: class {
    addListener(_: string, cb: Listener) {
      mockListeners.add(cb);
      return { remove: () => mockListeners.delete(cb) };
    }
  },
}));

// The real provider renders nothing until native insets arrive.
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

const App = require('../App').default;

const G = 9.80665;
let t = 0;
/** 1 s of 100 Hz flat walking (2 steps/s), heading north, recording on. */
function emitSecond() {
  for (let b = 0; b < 10; b++) {
    const acc: number[] = [];
    const rot: number[] = [];
    for (let i = 0; i < 10; i++, t += 0.01) {
      acc.push(t, 0, 0, G + 2.5 * Math.sin(2 * Math.PI * 2 * t));
      rot.push(t, 0, 0, 0, 1);
    }
    const batch = {
      acc,
      gyr: [],
      mag: [],
      rot,
      gps: [],
      magAccuracy: 3,
      sats: 10,
      recording: {
        id: 'rec-test',
        elapsedS: t,
        bytes: 1,
        accRows: 1,
        gpsFixes: 0,
      },
    };
    mockListeners.forEach(cb => cb(batch));
  }
}

type Inst = ReactTestRenderer.ReactTestInstance;
/** All rendered strings under a node, one host Text per line. */
function textOf(n: Inst | string): string {
  if (typeof n === 'string') {
    return n;
  }
  const inner = n.children.map(textOf).join('');
  return /^(RCT)?Text$/.test(String(n.type)) ? `${inner}\n` : inner;
}
const texts = (r: ReactTestRenderer.ReactTestRenderer) => textOf(r.root);

/** Press the innermost pressable whose text matches. */
function press(r: ReactTestRenderer.ReactTestRenderer, label: RegExp) {
  const hits = r.root.findAll(
    x =>
      typeof x.props.onPress === 'function' &&
      label.test(textOf(x).trim().toLowerCase()),
  );
  expect(hits.length).toBeGreaterThan(0);
  hits[hits.length - 1].props.onPress();
}

test('tab switches keep sensors, recording and PDR running', async () => {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(<App />);
    await new Promise(res => setTimeout(res, 0));
  });
  expect(native.start).toHaveBeenCalledTimes(1);

  await act(async () => press(r, /start recording/));
  expect(native.startRecording).toHaveBeenCalledTimes(1);

  await act(async () => press(r, /^track$/));
  await act(async () => press(r, /start pdr/));
  await act(async () => emitSecond());
  const steps = () => Number(/STEPS (\d+)/.exec(texts(r))![1]);
  const before = steps();
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 3; i++) {
    for (const tab of [/^vehicle/, /^calibrate$/, /^track$/]) {
      await act(async () => press(r, tab));
      // Data keeps flowing while Track is hidden.
      await act(async () => emitSecond());
    }
  }

  expect(native.stop).not.toHaveBeenCalled();
  expect(native.stopRecording).not.toHaveBeenCalled();
  expect(texts(r)).toMatch(/■ Stop/i); // Track button still "■ Stop"
  expect(texts(r)).toMatch(/REC/); // Recording panel still recording
  expect(steps()).toBeGreaterThan(before + 10); // steps counted while hidden
  expect(mockListeners.size).toBeGreaterThanOrEqual(2); // Calibrate + Track subscribed

  await act(async () => r.unmount());
});
