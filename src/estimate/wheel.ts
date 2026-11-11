import { headingFromQuat } from '../sensors/imu';
import { Quat, TrackPt, rotate, unrotate } from './ins';

/**
 * M5 wheel-speed engine: OBD vehicle speed (PID 0x0D) × vehicle heading.
 *
 * The phone sits in the car at an unknown angle, so the car's forward axis in
 * the phone frame is learned from the IMU alone: while OBD speed rises the
 * horizontal acceleration points forward, while it falls it points back.
 * Heading = that axis rotated to ENU by the rotation vector. Distance is kept
 * as short segments (Δd, attitude), so the whole path is redrawn whenever the
 * axis estimate improves. Until learned, the phone's top edge is used.
 */
export type WheelParams = {
  minLongAcc: number; // m/s² speed change per s for an interval to count
  learnIntervals: number; // freeze the forward axis after this many
  staleS: number; // speed older than this counts as 0
  segHz: number;
};

export const DEFAULT_WHEEL: WheelParams = {
  minLongAcc: 0.4,
  learnIntervals: 40,
  staleS: 6,
  segHz: 10,
};

type Seg = { t: number; d: number; q: Quat };

export class Wheel {
  readonly p: WheelParams;
  distance = 0;
  speeds = 0;
  /** Learned car-forward axis in the phone frame (unnormalised sum). */
  fwd: [number, number, number] = [0, 0, 0];
  learned = 0;

  private segs: Seg[] = [];
  private q: Quat | null = null;
  private v = 0;
  private vT = -Infinity;
  private lastT: number | null = null;
  private segD = 0;
  private lastSegT = -Infinity;
  private acc: [number, number, number] = [0, 0, 0];
  private accN = 0;
  private cache: { key: number; len: number; pts: TrackPt[] } | null = null;

  constructor(params: Partial<WheelParams> = {}) {
    this.p = { ...DEFAULT_WHEEL, ...params };
  }

  /** One OBD reading. Timestamps on the IMU clock. */
  addSpeed(t: number, kmh: number) {
    const v = kmh / 3.6;
    const dt = t - this.vT;
    if (this.accN && dt > 0 && dt < 5 && this.learned < this.p.learnIntervals) {
      const la = (v - this.v) / dt;
      if (Math.abs(la) >= this.p.minLongAcc) {
        const s = Math.sign(la) / this.accN;
        this.fwd[0] += s * this.acc[0];
        this.fwd[1] += s * this.acc[1];
        this.fwd[2] += s * this.acc[2];
        this.learned++;
      }
    }
    this.acc = [0, 0, 0];
    this.accN = 0;
    this.v = v;
    this.vT = t;
    this.speeds++;
  }

  addRot(rot: number[]) {
    for (let i = 0; i + 4 < rot.length; i += 5) {
      this.q = [rot[i + 1], rot[i + 2], rot[i + 3], rot[i + 4]];
      this.advance(rot[i]);
    }
  }

  /** Accel only teaches the forward axis. */
  addAcc(acc: number[]) {
    if (!this.q || this.learned >= this.p.learnIntervals) {
      return;
    }
    for (let i = 0; i + 3 < acc.length; i += 4) {
      const w = rotate(this.q, [acc[i + 1], acc[i + 2], acc[i + 3]]);
      // Horizontal part only, back in the phone frame.
      const d = unrotate(this.q, [w[0], w[1], 0]);
      this.acc[0] += d[0];
      this.acc[1] += d[1];
      this.acc[2] += d[2];
      this.accN++;
    }
  }

  private advance(t: number) {
    if (this.lastT == null) {
      this.lastT = t;
      this.segs.push({ t, d: 0, q: this.q! });
      this.lastSegT = t;
      return;
    }
    const dt = Math.max(0, Math.min(0.5, t - this.lastT));
    this.lastT = t;
    const v = t - this.vT <= this.p.staleS ? this.v : 0;
    this.segD += v * dt;
    this.distance += v * dt;
    if (t - this.lastSegT >= 1 / this.p.segHz) {
      this.segs.push({ t, d: this.segD, q: this.q! });
      this.segD = 0;
      this.lastSegT = t;
    }
  }

  /** Heading (deg from north) of the car's forward axis for attitude q. */
  headingAt(q: Quat): number {
    const h = this.fwd;
    if (this.learned > 0 && Math.hypot(h[0], h[1], h[2]) > 1e-6) {
      const w = rotate(q, h);
      if (Math.hypot(w[0], w[1]) > 1e-6) {
        return ((Math.atan2(w[0], w[1]) * 180) / Math.PI + 360) % 360;
      }
    }
    return headingFromQuat(q[0], q[1], q[2], q[3]);
  }

  get heading(): number | null {
    return this.q ? this.headingAt(this.q) : null;
  }

  /** Path in local metres with the current forward-axis estimate. */
  track(): TrackPt[] {
    const c = this.cache;
    if (c && c.key === this.learned) {
      // Same axis: extend incrementally.
      let last = c.pts[c.pts.length - 1];
      for (let i = c.len; i < this.segs.length; i++) {
        last = this.step(last, this.segs[i]);
        c.pts.push(last);
      }
      c.len = this.segs.length;
      return c.pts;
    }
    const pts: TrackPt[] = [];
    let last: TrackPt | null = null;
    for (const sg of this.segs) {
      last = last ? this.step(last, sg) : { t: sg.t, e: 0, n: 0 };
      pts.push(last);
    }
    this.cache = { key: this.learned, len: this.segs.length, pts };
    return pts;
  }

  private step(prev: TrackPt, sg: Seg): TrackPt {
    const h = (this.headingAt(sg.q) * Math.PI) / 180;
    return {
      t: sg.t,
      e: prev.e + sg.d * Math.sin(h),
      n: prev.n + sg.d * Math.cos(h),
    };
  }
}

/** OBD speeds from events.log: "obd kmh=N" or a raw 010D response. */
export function parseObdSpeeds(events: string): number[] {
  const app: number[] = [];
  const raw: number[] = [];
  for (const line of events.split('\n')) {
    const a = line.match(/^(\S+) .*obd kmh=(\d+)/);
    const r = line.match(/^(\S+) .*CMD 010D => "[^"]*?410D([0-9A-F]{2})/i);
    if (a && Number.isFinite(+a[1])) {
      app.push(+a[1], +a[2]);
    } else if (r && Number.isFinite(+r[1])) {
      raw.push(+r[1], parseInt(r[2], 16));
    }
  }
  // Newer recordings log both; prefer the app's own line.
  return app.length ? app : raw;
}
