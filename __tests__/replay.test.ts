/// <reference types="node" />
import fs from 'fs';
import path from 'path';
import { Pdr } from '../src/estimate/pdr';
import {
  frameAt,
  parseGps,
  parseImu,
  replay,
  runPdr,
  startMs,
  toCsv,
  toGpx,
} from '../src/session/replay';
import { parseObdSpeeds } from '../src/estimate/wheel';

const G = 9.80665;

test('parseGps / parseImu skip headers, junk and other sensors', () => {
  const gps = parseGps(
    't,lat,lon,alt,acc,speed,bearing,sats\n1.5,45,-122,10,3,1,90,12\n\nbad\n',
  );
  expect(gps).toEqual([
    { t: 1.5, lat: 45, lon: -122, alt: 10, acc: 3, speed: 1, bearing: 90 },
  ]);
  const imu = parseImu(
    't,s,x,y,z,w\n0.1,a,1,2,3\n0.1,g,9,9,9\n0.2,r,0,0,0,1\n0.3,m,1,1,1\n',
  );
  expect(imu.acc).toEqual([0.1, 1, 2, 3]);
  expect(imu.rot).toEqual([0.2, 0, 0, 0, 1]);
});

test('startMs accepts Android "-0600" offsets and Z', () => {
  expect(startMs('2026-11-11T07:18:40.728-0600')).toBe(
    Date.parse('2026-11-11T13:18:40.728Z'),
  );
  expect(startMs('2026-11-11T13:18:40.728Z')).toBe(
    Date.parse('2026-11-11T13:18:40.728Z'),
  );
  expect(startMs('nope')).toBeNull();
  expect(startMs(undefined)).toBeNull();
});

/** 60 s synthetic walk east at 2 steps/s with GPS fixes every second. */
function synthetic() {
  const acc: number[] = [];
  const rot: number[] = [];
  const half = (-90 * Math.PI) / 360;
  for (let i = 0; i < 6000; i++) {
    const t = i / 100;
    acc.push(t, 0, 0, G + 2.5 * Math.sin(2 * Math.PI * 2 * t));
    rot.push(t, 0, 0, Math.sin(half), Math.cos(half));
  }
  const gpsCsv = ['t,lat,lon,alt,acc,speed,bearing,sats'];
  for (let t = 0; t <= 60; t++) {
    // ~1.4 m/s east at lat 45
    gpsCsv.push(`${t},45,${-122 + (t * 1.4) / 78846},0,3,1.4,90,12`);
  }
  return { imu: { acc, rot }, fixes: parseGps(gpsCsv.join('\n')) };
}

test('replay is deterministic and matches live-style batching', () => {
  const { imu, fixes } = synthetic();
  const a = replay(fixes, imu);
  const b = replay(fixes, imu);
  expect(b).toEqual(a);
  expect(a.steps).toBeGreaterThan(110);
  expect(a.est[0]).toEqual({ t: 0, e: 0, n: 0 });
  expect(a.est[a.est.length - 1].e).toBeGreaterThan(50);
  expect(a.gpsDist).toBeCloseTo(84, 0);
  expect(a.stats.series).toHaveLength(61);
  expect(a.errPerDist).not.toBeNull();
  // Same result as feeding a Pdr by hand.
  const p = runPdr(new Pdr(), imu);
  expect(p.distance).toBeCloseTo(a.estDist, 9);
});

test('frameAt cuts every track at the playhead', () => {
  const { imu, fixes } = synthetic();
  const r = replay(fixes, imu);
  const f = frameAt(r, 10.5);
  expect(f.gps.every(p => p.t <= 10.5)).toBe(true);
  expect(f.gps).toHaveLength(11);
  expect(f.est.every(p => p.t <= 10.5)).toBe(true);
  expect(f.links).toHaveLength(11);
  expect(f.err).toBe(r.stats.series[10].err);
  expect(f.focus).toBe(f.gps[10]);
  expect(frameAt(r, -1).est).toHaveLength(0);
  expect(frameAt(r, r.tEnd).est).toHaveLength(r.est.length);
});

test('GPX has both tracks with times; CSV one row per second', () => {
  const { imu, fixes } = synthetic();
  const r = replay(fixes, imu);
  const gpx = toGpx(r, 'walk <1>', fixes, Date.parse('2026-11-11T00:00:00Z'));
  expect(gpx).toMatch(/^<\?xml/);
  expect(gpx).toContain('<name>walk &lt;1&gt;</name>');
  expect(gpx.match(/<trk>/g)).toHaveLength(3); // GPS, PDR, INS
  const segs = gpx.split('<trk>').slice(1);
  expect(segs[0].match(/<trkpt/g)).toHaveLength(fixes.length);
  expect(segs[1].match(/<trkpt/g)).toHaveLength(r.est.length);
  expect(gpx).toContain('<time>2026-11-11T00:01:00.000Z</time>');
  expect(gpx.trim().endsWith('</gpx>')).toBe(true);

  const csv = toCsv(r).trim().split('\n');
  expect(csv[0]).toBe(
    't,gps_lat,gps_lon,est_lat,est_lon,gps_e,gps_n,est_e,est_n,err_m',
  );
  expect(csv).toHaveLength(1 + r.stats.series.length);
  const last = csv[csv.length - 1].split(',').map(Number);
  expect(last[9]).toBeCloseTo(r.stats.cur!, 2);
  expect(last[1]).toBeCloseTo(45, 6);
});

test('no GPS: replay still runs, exports are empty but valid', () => {
  const { imu } = synthetic();
  const r = replay([], imu);
  expect(r.origin).toBeNull();
  expect(r.stats.cur).toBeNull();
  expect(toCsv(r).trim().split('\n')).toHaveLength(1);
  expect(toGpx(r, 'x', [], null)).toContain('</gpx>');
});

// ---- Real recordings in test/data/recordings ----

const REC = path.join(__dirname, '../test/data/recordings');
const recordings = fs.existsSync(REC)
  ? fs.readdirSync(REC).filter(n => n.startsWith('rec-'))
  : [];

describe.each(recordings)('replay %s', name => {
  const dir = path.join(REC, name);
  const imuText = fs
    .readdirSync(dir)
    .filter(n => /^imu_\d+\.csv$/.test(n))
    .sort()
    .map(n => fs.readFileSync(path.join(dir, n), 'utf8'))
    .join('\n');
  const fixes = parseGps(fs.readFileSync(path.join(dir, 'gps.csv'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

  test('replays, exports and covers the whole session', () => {
    const started = Date.now();
    const events = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
    const speeds = parseObdSpeeds(events);
    const r = replay(fixes, parseImu(imuText), {}, speeds);
    const ms = Date.now() - started;
    console.log(name, {
      ms,
      steps: r.steps,
      fixes: fixes.length,
      finalErr: r.stats.cur?.toFixed(1),
      maxErr: r.stats.max?.toFixed(1),
      engines: r.engines.map(
        x =>
          `${x.id} mean=${x.stats.mean?.toFixed(0)} dist=${x.dist.toFixed(0)}`,
      ),
    });
    expect(r.origin).not.toBeNull();
    expect(r.gps).toHaveLength(meta.rows.gps);
    expect(r.tEnd).toBeGreaterThan(meta.durationS - 2);
    expect(r.stats.series.length).toBeGreaterThan(meta.durationS - 5);
    const gpx = toGpx(r, name, fixes, startMs(meta.startedAt));
    expect(gpx.match(/<trkpt/g)!.length).toBe(
      fixes.length + r.engines.reduce((n, x) => n + x.est.length, 0),
    );
    if (speeds.length) {
      // M5: OBD speed integrates to roughly the GPS distance.
      const wheel = r.engines.find(x => x.id === 'wheel')!;
      expect(wheel.dist / r.gpsDist).toBeGreaterThan(0.7);
      expect(wheel.dist / r.gpsDist).toBeLessThan(1.2);
      expect(wheel.est.length).toBeGreaterThan(meta.durationS * 5);
    }
    expect(gpx).toContain(`<time>${meta.startedAt.slice(0, 10)}`);
    expect(toCsv(r).trim().split('\n')).toHaveLength(1 + r.stats.series.length);
  });
});
