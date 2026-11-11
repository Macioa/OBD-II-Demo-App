/** Local east/north metres around an origin (flat-earth; fine for a few km). */
export type EN = { e: number; n: number };

const R = 6371008.8; // mean Earth radius, m
const rad = (d: number) => (d * Math.PI) / 180;

export function toEnu(
  lat: number,
  lon: number,
  lat0: number,
  lon0: number,
): EN {
  return {
    e: rad(lon - lon0) * R * Math.cos(rad(lat0)),
    n: rad(lat - lat0) * R,
  };
}

export function fromEnu(e: number, n: number, lat0: number, lon0: number) {
  return {
    lat: lat0 + (n / R) * (180 / Math.PI),
    lon: lon0 + (e / (R * Math.cos(rad(lat0)))) * (180 / Math.PI),
  };
}

export const dist = (a: EN, b: EN) => Math.hypot(a.e - b.e, a.n - b.n);

/** Total length of a polyline. */
export function pathLength(p: EN[]) {
  let d = 0;
  for (let i = 1; i < p.length; i++) {
    d += dist(p[i - 1], p[i]);
  }
  return d;
}

/** Linear interpolation of a timed track at time t (clamped to its ends). */
export function at<T extends EN & { t: number }>(track: T[], t: number): EN {
  if (!track.length) {
    return { e: 0, n: 0 };
  }
  if (t <= track[0].t) {
    return track[0];
  }
  for (let i = 1; i < track.length; i++) {
    if (track[i].t >= t) {
      const a = track[i - 1];
      const b = track[i];
      const k = (t - a.t) / (b.t - a.t || 1);
      return { e: a.e + k * (b.e - a.e), n: a.n + k * (b.n - a.n) };
    }
  }
  return track[track.length - 1];
}
