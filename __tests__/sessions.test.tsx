/// <reference types="node" />
/** M4 Sessions tab: list → replay → scrub/play → export GPX/CSV. */
import fs from 'fs';
import path from 'path';
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { NativeModules } from 'react-native';

const REC = path.join(__dirname, '../test/data/recordings');
const ID = 'rec-2026-11-11T07-18-40';
const dir = path.join(REC, ID);
const files = {
  meta: fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'),
  gps: fs.readFileSync(path.join(dir, 'gps.csv'), 'utf8'),
  imu: fs.readFileSync(path.join(dir, 'imu_000.csv'), 'utf8'),
};

const native = {
  listRecordings: jest.fn().mockResolvedValue([
    {
      id: ID,
      active: false,
      bytes: 2e6,
      durationS: 122,
      startedAt: '',
      gpsFixes: 122,
      accRows: 1,
    },
    {
      id: 'rec-2026-11-12T00-00-00',
      active: true,
      bytes: 1,
      durationS: -1,
      startedAt: '',
      gpsFixes: 0,
      accRows: 0,
    },
  ]),
  loadRecording: jest.fn().mockResolvedValue(files),
  shareExports: jest.fn().mockResolvedValue(2),
  deleteRecording: jest.fn(),
  logEvent: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
NativeModules.ImuSensors = native;

const SessionsScreen = require('../src/screens/SessionsScreen').default;

type Inst = ReactTestRenderer.ReactTestInstance;
function textOf(n: Inst | string): string {
  if (typeof n === 'string') {
    return n;
  }
  const inner = n.children.map(textOf).join('');
  return /^(RCT)?Text$/.test(String(n.type)) ? `${inner}\n` : inner;
}
function press(r: ReactTestRenderer.ReactTestRenderer, label: RegExp) {
  const hits = r.root.findAll(
    x => typeof x.props.onPress === 'function' && label.test(textOf(x).trim()),
  );
  expect(hits.length).toBeGreaterThan(0);
  hits[hits.length - 1].props.onPress({ nativeEvent: {} });
}
const flush = () => new Promise<void>(res => setImmediate(res));

test('list, open, replay, scrub, play and export a session', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  let r!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    r = ReactTestRenderer.create(<SessionsScreen active />);
  });
  await act(flush);
  const txt = () => textOf(r.root);
  expect(txt()).toMatch(/2026-11-11T07-18-40/);
  expect(txt()).toMatch(/recording…/);
  const activeItem = r.root.findByProps({
    testID: 'session-rec-2026-11-12T00-00-00',
  });
  expect(activeItem.props.disabled).toBe(true);

  await act(async () => press(r, /^2026-11-11T07-18-40/));
  await act(flush);
  expect(native.loadRecording).toHaveBeenCalledWith(ID);
  expect(txt()).toMatch(/FIXES 122/);
  expect(txt()).toMatch(/STEPS \d+/);
  expect(txt()).toMatch(/DIST +FINAL +MAX +MEAN/);
  expect(txt()).toMatch(/PDR +\d+ +\d+ +\d+/);
  expect(txt()).toMatch(/INS +\d+/);
  expect(txt()).toMatch(/no OBD speed/);
  expect(txt()).toMatch(/2:01\/2:01|2:02\/2:02/); // starts at the end

  // Scrub to the middle via the bar.
  const bar = r.root.findByProps({ testID: 'replay-bar' });
  await act(async () => {
    bar.props.onLayout({ nativeEvent: { layout: { width: 200 } } });
  });
  await act(async () => bar.props.onPress({ nativeEvent: { locationX: 100 } }));
  expect(txt()).toMatch(/1:0\d\/2:0\d/);

  // Play at 8×: 1 s of real time ≈ 8 s of session.
  const before = /(\d+):(\d+)\//.exec(txt())!;
  const sec = (m: RegExpExecArray) => +m[1] * 60 + +m[2];
  await act(async () => press(r, /^▶$/));
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  const after = /(\d+):(\d+)\//.exec(txt())!;
  expect(sec(after) - sec(before)).toBeGreaterThanOrEqual(7);
  expect(sec(after) - sec(before)).toBeLessThanOrEqual(9);
  await act(async () => press(r, /^❚❚$/));

  await act(async () => press(r, /^Both$/));
  await act(flush);
  expect(native.shareExports).toHaveBeenCalledTimes(1);
  const [id, out] = native.shareExports.mock.calls[0];
  expect(id).toBe(ID);
  expect(Object.keys(out).sort()).toEqual([`${ID}-pdr-error.csv`, `${ID}.gpx`]);
  expect(out[`${ID}.gpx`]).toContain('<trk><name>GPS</name>');
  expect(out[`${ID}-pdr-error.csv`].split('\n').length).toBeGreaterThan(100);

  await act(async () => press(r, /Back/));
  await act(flush);
  expect(txt()).toMatch(/Sessions/);
  await act(async () => r.unmount());
  jest.useRealTimers();
});
