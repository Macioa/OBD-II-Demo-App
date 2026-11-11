import { Ins, Quat, rotate, unrotate } from '../src/estimate/ins';
import { Wheel, parseObdSpeeds } from '../src/estimate/wheel';
import { frameAt, parseGps, replay } from '../src/session/replay';

const G = 9.80665;
/** Yaw-only quaternion: phone rotated by `deg` counter-clockwise (seen from above). */
const yaw = (deg: number): Quat => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
};

test('rotate / unrotate are inverse and match a 90° yaw', () => {
  const q = yaw(90);
  const v = rotate(q, [0, 1, 0]); // phone top edge → west
  expect(v[0]).toBeCloseTo(-1, 9);
  expect(v[1]).toBeCloseTo(0, 9);
  const back = unrotate(q, v);
  expect(back[1]).toBeCloseTo(1, 9);
});

/** Flat stride streams at 100 Hz; accel(t) gives device-frame specific force. */
function stream(seconds: number, q: Quat, accel: (t: number) => number[]) {
  const acc: number[] = [];
  const rot: number[] = [];
  for (let i = 0; i < seconds * 100; i++) {
    const t = i / 100;
    rot.push(t, ...q);
    acc.push(t, ...accel(t));
  }
  return { acc, rot };
}

test('INS: still phone triggers ZUPT and stays put', () => {
  const ins = new Ins();
  const { acc, rot } = stream(20, yaw(0), () => [0, 0, G]);
  ins.addRot(rot.slice(0, 5));
  ins.addAcc(acc);
  expect(ins.zupts).toBeGreaterThan(0);
  expect(ins.still).toBe(true);
  expect(Math.hypot(ins.e, ins.n)).toBeLessThan(0.01);
});

test('INS: constant 1 m/s² north for 5 s ≈ 12.5 m (½at²)', () => {
  const ins = new Ins({ zuptStd: -1 }); // ZUPT off
  const { acc, rot } = stream(5, yaw(0), () => [0, 1, G]);
  ins.addRot(rot.slice(0, 5));
  ins.addAcc(acc);
  expect(ins.n).toBeCloseTo(12.5, 0);
  expect(Math.abs(ins.e)).toBeLessThan(0.01);
  expect(ins.speed).toBeCloseTo(5, 1);
});

test('Wheel: learns the car axis of a phone mounted sideways', () => {
  // Phone faces north but the car drives east: forward is the phone's +X.
  const q = yaw(0);
  const w = new Wheel();
  // 0–10 s accelerate 0→20 m/s along +X (east), then cruise 20 s.
  let si = 0;
  const kmhAt = (t: number) => Math.min(t, 10) * 2 * 3.6;
  for (let i = 0; i < 3000; i++) {
    const t = i / 100;
    w.addRot([t, ...q]);
    if (t >= si) {
      w.addSpeed(t, Math.round(kmhAt(t)));
      si += 1;
    }
    w.addAcc([t, t < 10 ? 2 : 0, 0, G]);
  }
  expect(w.learned).toBeGreaterThan(5);
  expect(w.heading!).toBeCloseTo(90, 0);
  const end = w.track()[w.track().length - 1];
  // ~100 m accelerating + 400 m cruising, all east.
  expect(end.e).toBeGreaterThan(450);
  expect(end.e).toBeLessThan(530);
  expect(Math.abs(end.n)).toBeLessThan(1);
});

test('Wheel: speed older than staleS stops the car', () => {
  const w = new Wheel({ staleS: 2 });
  w.addSpeed(0, 36);
  for (let i = 0; i <= 1000; i++) {
    w.addRot([i / 100, ...yaw(0)]);
  }
  expect(w.distance).toBeCloseTo(20, 0); // 10 m/s for 2 s, then nothing
});

test('parseObdSpeeds reads app lines, else raw 010D replies', () => {
  const raw =
    '7.74 app: CMD 010D => "410D06"\n8.1 app: CMD 010C => "410C1000"\n9.0 app: CMD 010D => "410D1A"\n';
  expect(parseObdSpeeds(raw)).toEqual([7.74, 6, 9.0, 26]);
  expect(parseObdSpeeds(raw + '9.5 app: obd kmh=30\n')).toEqual([9.5, 30]);
  expect(parseObdSpeeds('')).toEqual([]);
});

test('replay includes the wheel engine only with OBD speed; frameAt picks it', () => {
  const gpsCsv = ['t,lat,lon,alt,acc,speed,bearing,sats'];
  for (let t = 0; t <= 20; t++) {
    gpsCsv.push(`${t},45,${-122 + (t * 10) / 78846},0,3,10,90,12`);
  }
  const fixes = parseGps(gpsCsv.join('\n'));
  const imu = stream(20, yaw(-90), () => [0, 0, G]); // top edge east
  expect(replay(fixes, imu).engines.map(x => x.id)).toEqual(['pdr', 'ins']);
  const speeds: number[] = [];
  for (let t = 0; t <= 20; t++) {
    speeds.push(t, 36);
  }
  const r = replay(fixes, imu, {}, speeds);
  expect(r.engines.map(x => x.id)).toEqual(['pdr', 'ins', 'wheel']);
  const wheel = r.engines[2];
  // No accel events → falls back to the top edge (east): tracks GPS closely.
  expect(wheel.stats.max!).toBeLessThan(15);
  const f = frameAt(r, 10, 'wheel');
  expect(f.cur.e).toBeGreaterThan(90);
  expect(f.others.map(o => o.id)).toEqual(['pdr', 'ins']);
});

test('PDR ignores steps while OBD says the car is moving', () => {
  const { Pdr } = require('../src/estimate/pdr');
  const walk = (p: any, from: number, kmh: number) => {
    for (let i = 0; i < 1000; i++) {
      const t = from + i / 100;
      if (i % 100 === 0) {
        p.addSpeed(t, kmh); // OBD ~1 Hz
      }
      p.sample(t, 0, 0, G + 2.5 * Math.sin(2 * Math.PI * 2 * t));
    }
  };
  const p = new Pdr();
  walk(p, 0, 40);
  expect(p.steps).toHaveLength(0);
  expect(p.gated).toBeGreaterThan(10);
  walk(p, 10, 0); // parked: walking counts again
  expect(p.steps.length).toBeGreaterThan(10);
});
