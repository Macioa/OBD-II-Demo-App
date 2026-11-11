import { EN, at, dist, fromEnu } from './enu';

/** Map overlay (M3): GPS truth + estimate as GeoJSON, plus drift stats. */
export type Timed = EN & { t: number };
export type Origin = { lat: number; lon: number };

export type ErrorStats = {
  /** Error at each whole second since t0 (estimate vs GPS at the same t). */
  series: { t: number; err: number; a: EN; b: EN }[];
  cur: number | null;
  max: number | null;
  mean: number | null;
};

/**
 * Per-second error between the estimate and GPS, only over the time span GPS
 * actually covers (no clamped extrapolation before the first fix).
 */
export function errorStats(
  est: Timed[],
  gps: Timed[],
  t0: number,
  t: number,
): ErrorStats {
  const series: ErrorStats['series'] = [];
  if (!est.length || !gps.length) {
    return { series, cur: null, max: null, mean: null };
  }
  const from = Math.max(t0, gps[0].t);
  for (let s = Math.ceil(from - t0); t0 + s <= t; s++) {
    const ts = t0 + s;
    const a = at(gps, ts);
    const b = at(est, ts);
    series.push({ t: ts, err: dist(a, b), a, b });
  }
  const errs = series.map(x => x.err);
  return {
    series,
    cur: errs.length ? errs[errs.length - 1] : null,
    max: errs.length ? Math.max(...errs) : null,
    mean: errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : null,
  };
}

export const ll = (p: EN, o: Origin): [number, number] => {
  const g = fromEnu(p.e, p.n, o.lat, o.lon);
  return [g.lon, g.lat];
};

const line = (pts: EN[], o: Origin): GeoJSON.Feature<GeoJSON.LineString> => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: pts.map(p => ll(p, o)) },
});

export function toGeoJson(
  o: Origin,
  est: EN[],
  gps: EN[],
  links: { a: EN; b: EN }[],
) {
  // A LineString needs ≥2 points; duplicate a lone point.
  const two = (p: EN[]) => (p.length === 1 ? [p[0], p[0]] : p);
  return {
    est: line(two(est), o),
    gps: line(two(gps), o),
    links: {
      type: 'FeatureCollection',
      features: links.map(l => line([l.a, l.b], o)),
    } as GeoJSON.FeatureCollection<GeoJSON.LineString>,
  };
}

/** [west, south, east, north] around the points, padded by `padM` metres. */
export function boundsOf(
  o: Origin,
  pts: EN[],
  padM: number,
): [number, number, number, number] {
  let minE = 0,
    maxE = 0,
    minN = 0,
    maxN = 0;
  for (const p of pts) {
    minE = Math.min(minE, p.e);
    maxE = Math.max(maxE, p.e);
    minN = Math.min(minN, p.n);
    maxN = Math.max(maxN, p.n);
  }
  const sw = ll({ e: minE - padM, n: minN - padM }, o);
  const ne = ll({ e: maxE + padM, n: maxN + padM }, o);
  return [sw[0], sw[1], ne[0], ne[1]];
}

/**
 * True when [lon, lat] lies outside the inner box of `view` ([w, s, e, n])
 * left after trimming `margin` (fraction of width/height) off every side.
 */
export function nearEdge(
  pt: [number, number],
  view: [number, number, number, number],
  margin = 0.15,
) {
  const [w, s, e, n] = view;
  const dx = (e - w) * margin;
  const dy = (n - s) * margin;
  return pt[0] < w + dx || pt[0] > e - dx || pt[1] < s + dy || pt[1] > n - dy;
}
