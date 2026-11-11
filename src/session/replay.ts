import { Ins } from '../estimate/ins';
import { DEFAULT_PDR, Pdr, PdrParams } from '../estimate/pdr';
import { Wheel } from '../estimate/wheel';
import { EN, fromEnu, pathLength, toEnu } from '../geo/enu';
import { ErrorStats, Origin, Timed, errorStats } from '../geo/overlay';

/**
 * M4: replay a recorded session through the estimator. Pure: the same text in
 * gives the same path out, on the phone or in Jest against test/data.
 */
export type GpsFix = {
  t: number;
  lat: number;
  lon: number;
  alt: number;
  acc: number;
  speed: number;
  bearing: number;
};

export type Imu = { acc: number[]; rot: number[] };

export function parseGps(csv: string): GpsFix[] {
  const out: GpsFix[] = [];
  for (const line of csv.split('\n').slice(1)) {
    const c = line.split(',');
    if (c.length < 3 || !c[0]) {
      continue;
    }
    const [t, lat, lon, alt, acc, speed, bearing] = c.map(Number);
    if (Number.isFinite(t) && Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push({ t, lat, lon, alt, acc, speed, bearing });
    }
  }
  return out;
}

/** Accel and rotation-vector rows from imu_NNN.csv text (headers skipped). */
export function parseImu(csv: string, into: Imu = { acc: [], rot: [] }): Imu {
  for (const line of csv.split('\n')) {
    const c = line.split(',');
    if (c[1] === 'a' && c.length >= 5) {
      into.acc.push(+c[0], +c[2], +c[3], +c[4]);
    } else if (c[1] === 'r' && c.length >= 6) {
      into.rot.push(+c[0], +c[2], +c[3], +c[4], +c[5]);
    }
  }
  return into;
}

/**
 * Feed the streams in 100 ms batches, rotation before accel, exactly like the
 * live imuBatch events, so heading at each step matches what was seen live.
 */
export function runPdr(pdr: Pdr, imu: Imu, batchS = 0.1) {
  const { acc, rot } = imu;
  if (!acc.length) {
    return pdr;
  }
  let ai = 0;
  let ri = 0;
  for (let end = acc[0] + batchS; ai < acc.length; end += batchS) {
    const r0 = ri;
    while (ri < rot.length && rot[ri] < end) {
      ri += 5;
    }
    const a0 = ai;
    while (ai < acc.length && acc[ai] < end) {
      ai += 4;
    }
    pdr.addRot(rot.slice(r0, ri));
    pdr.addAcc(acc.slice(a0, ai));
  }
  return pdr;
}

/**
 * M5: PDR, INS and wheel-speed fed the same 100 ms batches (rotation, then
 * OBD speeds, then accel), the order the live Track screen uses.
 */
export function runEngines(imu: Imu, speeds: number[] = [], batchS = 0.1) {
  const pdr = new Pdr();
  const ins = new Ins();
  const wheel = new Wheel();
  const { acc, rot } = imu;
  let ai = 0;
  let ri = 0;
  let si = 0;
  for (let end = (acc[0] ?? 0) + batchS; ai < acc.length; end += batchS) {
    const r0 = ri;
    while (ri < rot.length && rot[ri] < end) {
      ri += 5;
    }
    const a0 = ai;
    while (ai < acc.length && acc[ai] < end) {
      ai += 4;
    }
    const r = rot.slice(r0, ri);
    const a = acc.slice(a0, ai);
    pdr.addRot(r);
    ins.addRot(r);
    wheel.addRot(r);
    while (si < speeds.length && speeds[si] < end) {
      wheel.addSpeed(speeds[si], speeds[si + 1]);
      si += 2;
    }
    pdr.addAcc(a);
    ins.addAcc(a);
    wheel.addAcc(a);
  }
  return { pdr, ins, wheel };
}

export type EngineId = 'pdr' | 'ins' | 'wheel';
export const ENGINES: Record<EngineId, { label: string; color: string }> = {
  pdr: { label: 'PDR', color: '#d84315' },
  ins: { label: 'INS', color: '#6a1b9a' },
  wheel: { label: 'Wheel', color: '#2e7d32' },
};

export type EngineRun = {
  id: EngineId;
  est: Timed[];
  dist: number;
  stats: ErrorStats;
  errPerDist: number | null;
};

export type Replay = {
  origin: Origin | null;
  gps: Timed[];
  est: Timed[];
  t0: number;
  tEnd: number;
  steps: number;
  estDist: number;
  gpsDist: number;
  stats: ErrorStats;
  /** Final error as a fraction of GPS distance; null when GPS barely moved. */
  errPerDist: number | null;
  /** M5: every engine on the same data; PDR first, wheel only with OBD speed. */
  engines: EngineRun[];
  obdSpeeds: number;
};

export function replay(
  fixes: GpsFix[],
  imu: Imu,
  params: Partial<PdrParams> = {},
  speeds: number[] = [],
): Replay {
  const pdr = runPdr(new Pdr({ ...DEFAULT_PDR, ...params }), imu);
  const { ins, wheel } = runEngines(imu, speeds);
  const origin = fixes.length ? { lat: fixes[0].lat, lon: fixes[0].lon } : null;
  const gps: Timed[] = origin
    ? fixes.map(f => ({
        t: f.t,
        ...toEnu(f.lat, f.lon, origin.lat, origin.lon),
      }))
    : [];
  const t0 = imu.acc.length ? imu.acc[0] : gps.length ? gps[0].t : 0;
  const tEnd = Math.max(
    imu.acc.length ? imu.acc[imu.acc.length - 4] : t0,
    gps.length ? gps[gps.length - 1].t : t0,
  );
  const est: Timed[] = [{ t: t0, e: 0, n: 0 }, ...pdr.steps];
  const stats = errorStats(est, gps, t0, tEnd);
  const gpsDist = pathLength(gps);
  const perDist = (cur: number | null) =>
    gpsDist >= 10 && cur != null ? cur / gpsDist : null;
  const run = (id: EngineId, e: Timed[], d: number): EngineRun => {
    const st = id === 'pdr' ? stats : errorStats(e, gps, t0, tEnd);
    return { id, est: e, dist: d, stats: st, errPerDist: perDist(st.cur) };
  };
  const engines = [
    run('pdr', est, pdr.distance),
    run(
      'ins',
      ins.track.length ? ins.track : [{ t: t0, e: 0, n: 0 }],
      ins.distance,
    ),
  ];
  if (speeds.length) {
    engines.push(run('wheel', wheel.track(), wheel.distance));
  }
  return {
    origin,
    gps,
    est,
    t0,
    tEnd,
    steps: pdr.steps.length,
    estDist: pdr.distance,
    gpsDist,
    stats,
    errPerDist: perDist(stats.cur),
    engines,
    obdSpeeds: speeds.length / 2,
  };
}

/**
 * Everything up to playhead time t, for drawing a replay frame. `engine`
 * picks the main estimate (with error links); the rest come back as `others`.
 */
export function frameAt(r: Replay, t: number, engine: EngineId = 'pdr') {
  const upTo = <T extends { t: number }>(a: T[]) => {
    let i = a.length;
    while (i > 0 && a[i - 1].t > t) {
      i--;
    }
    return a.slice(0, i);
  };
  const main = r.engines?.find(x => x.id === engine);
  const est = upTo(main?.est ?? r.est);
  const gps = upTo(r.gps);
  const links = upTo(main?.stats.series ?? r.stats.series);
  const others = (r.engines ?? [])
    .filter(x => x !== main)
    .map(x => ({ id: x.id, color: ENGINES[x.id].color, pts: upTo(x.est) }));
  const last = <T>(a: T[]) => (a.length ? a[a.length - 1] : undefined);
  return {
    est,
    gps,
    links,
    cur: (last(est) ?? { e: 0, n: 0 }) as EN,
    focus: (last(gps) ?? last(est) ?? { e: 0, n: 0 }) as EN,
    err: last(links)?.err ?? null,
    others,
  };
}

// ---- Export ----

/** meta.json startedAt ("…SSS-0600" or "…Z") → epoch ms, or null. */
export function startMs(startedAt: string | undefined): number | null {
  if (!startedAt) {
    return null;
  }
  const iso = startedAt.replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f7 = (x: number) => x.toFixed(7);

/** GPX 1.1: GPS truth, the PDR estimate, then INS / wheel estimates (M5). */
export function toGpx(
  r: Replay,
  name: string,
  fixes: GpsFix[],
  t0Ms: number | null,
) {
  const time = (t: number) =>
    t0Ms != null
      ? `<time>${new Date(t0Ms + t * 1000).toISOString()}</time>`
      : '';
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="OBD App" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name>${time(0)}</metadata>`,
    '<trk><name>GPS</name><trkseg>',
  ];
  for (const f of fixes) {
    out.push(
      `<trkpt lat="${f7(f.lat)}" lon="${f7(f.lon)}">` +
        (Number.isFinite(f.alt) ? `<ele>${f.alt.toFixed(1)}</ele>` : '') +
        `${time(f.t)}</trkpt>`,
    );
  }
  out.push('</trkseg></trk>', '<trk><name>PDR estimate</name><trkseg>');
  if (r.origin) {
    for (const p of r.est) {
      const g = fromEnu(p.e, p.n, r.origin.lat, r.origin.lon);
      out.push(
        `<trkpt lat="${f7(g.lat)}" lon="${f7(g.lon)}">${time(p.t)}</trkpt>`,
      );
    }
  }
  out.push('</trkseg></trk>');
  for (const x of r.engines ?? []) {
    if (x.id === 'pdr' || !r.origin) {
      continue;
    }
    out.push(`<trk><name>${ENGINES[x.id].label} estimate</name><trkseg>`);
    for (const p of x.est) {
      const g = fromEnu(p.e, p.n, r.origin.lat, r.origin.lon);
      out.push(
        `<trkpt lat="${f7(g.lat)}" lon="${f7(g.lon)}">${time(p.t)}</trkpt>`,
      );
    }
    out.push('</trkseg></trk>');
  }
  out.push('</gpx>', '');
  return out.join('\n');
}

/** One row per second over GPS coverage: both positions and the error. */
export function toCsv(r: Replay, engine: EngineId = 'pdr') {
  const stats = r.engines?.find(x => x.id === engine)?.stats ?? r.stats;
  const rows = [
    't,gps_lat,gps_lon,est_lat,est_lon,gps_e,gps_n,est_e,est_n,err_m',
  ];
  if (r.origin) {
    const o = r.origin;
    for (const s of stats.series) {
      const a = fromEnu(s.a.e, s.a.n, o.lat, o.lon);
      const b = fromEnu(s.b.e, s.b.n, o.lat, o.lon);
      rows.push(
        [
          s.t.toFixed(3),
          f7(a.lat),
          f7(a.lon),
          f7(b.lat),
          f7(b.lon),
          s.a.e.toFixed(2),
          s.a.n.toFixed(2),
          s.b.e.toFixed(2),
          s.b.n.toFixed(2),
          s.err.toFixed(2),
        ].join(','),
      );
    }
  }
  return rows.join('\n') + '\n';
}
