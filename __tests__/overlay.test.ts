import { fromEnu } from '../src/geo/enu';
import { boundsOf, errorStats, toGeoJson } from '../src/geo/overlay';

const O = { lat: 45, lon: -122 };

test('errorStats: per-second error over GPS coverage only', () => {
  // GPS heads east at 1 m/s; estimate heads north at 1 m/s. GPS starts at t=2.
  const gps = [2, 10].map(t => ({ t, e: t, n: 0 }));
  const est = [0, 10].map(t => ({ t, e: 0, n: t }));
  const s = errorStats(est, gps, 0, 10);
  expect(s.series.map(x => x.t)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(s.cur).toBeCloseTo(Math.hypot(10, 10));
  expect(s.max).toBeCloseTo(Math.hypot(10, 10));
  expect(s.mean).toBeCloseTo(Math.SQRT2 * 6);
});

test('errorStats: empty without GPS', () => {
  const s = errorStats([{ t: 0, e: 0, n: 0 }], [], 0, 5);
  expect(s).toEqual({ series: [], cur: null, max: null, mean: null });
});

test('toGeoJson: lon/lat order, lone point duplicated, links', () => {
  const g = toGeoJson(
    O,
    [{ e: 100, n: 0 }],
    [],
    [{ a: { e: 0, n: 0 }, b: { e: 0, n: 50 } }],
  );
  const [lon, lat] = g.est.geometry.coordinates[0];
  const exp = fromEnu(100, 0, O.lat, O.lon);
  expect(lon).toBeCloseTo(exp.lon, 9);
  expect(lat).toBeCloseTo(exp.lat, 9);
  expect(g.est.geometry.coordinates).toHaveLength(2);
  expect(g.gps.geometry.coordinates).toHaveLength(0);
  expect(g.links.features).toHaveLength(1);
});

test('boundsOf: [w,s,e,n] with padding, always contains origin', () => {
  const [w, s, e, n] = boundsOf(O, [{ e: 1000, n: 500 }], 100);
  expect(w).toBeLessThan(O.lon);
  expect(s).toBeLessThan(O.lat);
  expect(e).toBeCloseTo(fromEnu(1100, 0, O.lat, O.lon).lon, 9);
  expect(n).toBeCloseTo(fromEnu(0, 600, O.lat, O.lon).lat, 9);
});
