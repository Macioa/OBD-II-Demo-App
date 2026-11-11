/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { Pdr } from '../src/estimate/pdr';
import { at, dist, pathLength, toEnu } from '../src/geo/enu';

const G = 9.80665;
// Quaternion for compass heading h (clockwise from north), phone flat.
const quatFor = (h: number) => {
  const half = (-h * Math.PI) / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
};

/** 100 Hz flat-phone walk: 2 Hz vertical bounce, given heading per second. */
function walk(seconds: number, heading: (t: number) => number, amp = 2.5) {
  const acc: number[] = [];
  const rot: number[] = [];
  for (let i = 0; i < seconds * 100; i++) {
    const t = i / 100;
    const z = G + amp * Math.sin(2 * Math.PI * 2 * t) + 0.1 * Math.sin(37 * t);
    acc.push(t, 0.05, 0.02, z);
    rot.push(t, ...quatFor(heading(t)));
  }
  return { acc, rot };
}

/** Feed in 100 ms batches, rot before acc, like the live stream. */
function run(pdr: Pdr, acc: number[], rot: number[]) {
  for (let t0 = 0, ai = 0, ri = 0; ai < acc.length; t0 += 0.1) {
    const r: number[] = [];
    while (ri < rot.length && rot[ri] < t0 + 0.1) {
      r.push(...rot.slice(ri, ri + 5));
      ri += 5;
    }
    const a: number[] = [];
    while (ai < acc.length && acc[ai] < t0 + 0.1) {
      a.push(...acc.slice(ai, ai + 4));
      ai += 4;
    }
    pdr.addRot(r);
    pdr.addAcc(a);
  }
}

test('quatFor matches headingFromQuat convention', () => {
  const p = new Pdr();
  p.addRot([0, ...quatFor(90)]);
  expect(p.heading).toBeCloseTo(90);
});

test('60 s walk east at 2 Hz → ~120 steps heading east', () => {
  const { acc, rot } = walk(60, () => 90);
  const p = new Pdr();
  run(p, acc, rot);
  expect(p.steps.length).toBeGreaterThanOrEqual(115);
  expect(p.steps.length).toBeLessThanOrEqual(121);
  expect(p.e).toBeGreaterThan(50);
  expect(Math.abs(p.n)).toBeLessThan(1);
  expect(p.cadence(60)).toBeCloseTo(2, 0);
});

test('square walk closes the loop', () => {
  const { acc, rot } = walk(80, t => [0, 90, 180, 270][Math.floor(t / 20)]);
  const p = new Pdr();
  run(p, acc, rot);
  expect(Math.hypot(p.e, p.n)).toBeLessThan(2 * p.steps[0].len);
});

test('phone lying still → no steps', () => {
  const { acc, rot } = walk(30, () => 0, 0);
  const p = new Pdr();
  run(p, acc, rot);
  expect(p.steps).toHaveLength(0);
});

// ---- Replay of the real recording in test/data/recordings ----

const REC = path.join(__dirname, '../test/data/recordings');

function loadRecording(dir: string) {
  const acc: number[] = [];
  const rot: number[] = [];
  for (const f of fs
    .readdirSync(dir)
    .filter(n => /^imu_\d+\.csv$/.test(n))
    .sort()) {
    for (const line of fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split('\n')
      .slice(1)) {
      const c = line.split(',');
      if (c[1] === 'a') {
        acc.push(+c[0], +c[2], +c[3], +c[4]);
      } else if (c[1] === 'r') {
        rot.push(+c[0], +c[2], +c[3], +c[4], +c[5]);
      }
    }
  }
  const gpsRows = fs
    .readFileSync(path.join(dir, 'gps.csv'), 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map(l => l.split(',').map(Number));
  const [, lat0, lon0] = gpsRows[0];
  const gps = gpsRows.map(([t, lat, lon, , , speed, bearing]) => ({
    t,
    speed,
    bearing,
    ...toEnu(lat, lon, lat0, lon0),
  }));
  return { acc, rot, gps };
}

const recordings = fs.existsSync(REC)
  ? fs.readdirSync(REC).filter(n => n.startsWith('rec-'))
  : [];

describe.each(recordings)('recording %s', name => {
  const rec = loadRecording(path.join(REC, name));
  const pdr = new Pdr();
  run(pdr, rec.acc, rec.rot);
  const gpsDist = pathLength(rec.gps);
  const meanSpeed = gpsDist / rec.gps[rec.gps.length - 1].t;
  const driving = meanSpeed > 3;
  const report = {
    imuSamples: rec.acc.length / 4,
    gpsFixes: rec.gps.length,
    gpsDistM: +gpsDist.toFixed(1),
    meanSpeedMs: +meanSpeed.toFixed(2),
    steps: pdr.steps.length,
    pdrDistM: +pdr.distance.toFixed(1),
    finalErrM: +dist(at(rec.gps, rec.gps[rec.gps.length - 1].t), pdr).toFixed(
      1,
    ),
  };
  console.log(name, report);

  test('GPS track converts to local metres starting at origin', () => {
    expect(rec.gps[0].e).toBeCloseTo(0);
    expect(rec.gps[0].n).toBeCloseTo(0);
    // Sanity: ENU segment lengths agree with reported GPS speed (±50 %).
    const mid = rec.gps.slice(5, -5).filter(g => g.speed > 2);
    const ratios = mid.map((g, i) =>
      i ? dist(g, mid[i - 1]) / (g.t - mid[i - 1].t) / g.speed : 1,
    );
    ratios.sort((a, b) => a - b);
    if (ratios.length) {
      expect(ratios[Math.floor(ratios.length / 2)]).toBeGreaterThan(0.5);
      expect(ratios[Math.floor(ratios.length / 2)]).toBeLessThan(1.5);
    }
  });

  test('heading tracks GPS bearing changes (rotation vector is usable)', () => {
    // Compare *changes* in heading over 5 s windows, so a fixed phone mount
    // offset doesn't matter. Only while moving fast enough for a good bearing.
    const probe = new Pdr();
    const headingAt: { t: number; h: number }[] = [];
    for (let i = 0; i + 4 < rec.rot.length; i += 5 * 50) {
      probe.addRot(rec.rot.slice(i, i + 5));
      headingAt.push({ t: rec.rot[i], h: probe.heading! });
    }
    const hAt = (t: number) =>
      headingAt.reduce((b, x) =>
        Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b,
      ).h;
    const wrap = (d: number) => ((d + 540) % 360) - 180;
    const errs: number[] = [];
    const moving = rec.gps.filter(g => g.speed > 3);
    for (let i = 5; i < moving.length; i++) {
      const a = moving[i - 5];
      const b = moving[i];
      if (b.t - a.t > 6) {
        continue;
      }
      const dGps = wrap(b.bearing - a.bearing);
      const dImu = wrap(hAt(b.t) - hAt(a.t));
      errs.push(Math.abs(wrap(dGps - dImu)));
    }
    errs.sort((x, y) => x - y);
    const median = errs.length ? errs[Math.floor(errs.length / 2)] : 0;
    console.log(name, {
      headingChangeWindows: errs.length,
      medianErrDeg: +median.toFixed(1),
    });
    if (errs.length) {
      expect(median).toBeLessThan(15);
    }
  });

  test(
    driving ? 'driving: few false steps' : 'walking: steps match GPS distance',
    () => {
      if (driving) {
        // Car vibration should not look like walking.
        expect(pdr.steps.length).toBeLessThan(
          rec.gps[rec.gps.length - 1].t / 4,
        );
      } else {
        expect(pdr.distance).toBeGreaterThan(gpsDist * 0.7);
        expect(pdr.distance).toBeLessThan(gpsDist * 1.3);
      }
    },
  );
});
