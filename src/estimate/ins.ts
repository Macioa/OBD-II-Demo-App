import { Vec3 } from '../sensors/imu';

/**
 * M5 strapdown INS. Pure and streaming like Pdr: accelerometer (device frame,
 * includes gravity) is rotated to ENU with the rotation vector, gravity is
 * removed and the rest is integrated twice. ZUPT: while the phone is still
 * (|a| ≈ g with little jitter over a short window) velocity is reset to zero
 * and the horizontal residual is learned as accelerometer bias.
 */
export type InsParams = {
  zuptWindowS: number;
  zuptStd: number; // m/s², max std of |a| over the window
  zuptMean: number; // m/s², max | mean|a| − g |
  biasAlpha: number; // EMA weight per still sample
  outHz: number; // track points per second
};

export const DEFAULT_INS: InsParams = {
  zuptWindowS: 0.5,
  zuptStd: 0.12,
  zuptMean: 0.3,
  biasAlpha: 0.02,
  outHz: 10,
};

export type Quat = [number, number, number, number]; // x, y, z, w

const G = 9.80665;

/** Rotate v by unit quaternion q (device→world). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Inverse rotation (world→device). */
export const unrotate = (q: Quat, v: Vec3): Vec3 =>
  rotate([-q[0], -q[1], -q[2], q[3]], v);

export type TrackPt = { t: number; e: number; n: number };

export class Ins {
  readonly p: InsParams;
  track: TrackPt[] = [];
  e = 0;
  n = 0;
  ve = 0;
  vn = 0;
  distance = 0;
  still = false;
  zupts = 0;
  q: Quat | null = null;

  private bias: [number, number] = [0, 0];
  private lastT: number | null = null;
  private lastOut = -Infinity;
  private win: { t: number; m: number }[] = [];

  constructor(params: Partial<InsParams> = {}) {
    this.p = { ...DEFAULT_INS, ...params };
  }

  addRot(rot: number[]) {
    for (let i = 0; i + 4 < rot.length; i += 5) {
      this.q = [rot[i + 1], rot[i + 2], rot[i + 3], rot[i + 4]];
    }
  }

  addAcc(acc: number[]) {
    for (let i = 0; i + 3 < acc.length; i += 4) {
      this.sample(acc[i], acc[i + 1], acc[i + 2], acc[i + 3]);
    }
  }

  sample(t: number, x: number, y: number, z: number) {
    const m = Math.hypot(x, y, z);
    this.win.push({ t, m });
    while (this.win.length && this.win[0].t < t - this.p.zuptWindowS) {
      this.win.shift();
    }
    if (this.lastT == null || !this.q) {
      this.lastT = t;
      this.track.push({ t, e: 0, n: 0 });
      this.lastOut = t;
      return;
    }
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;

    let mean = 0;
    for (const w of this.win) {
      mean += w.m;
    }
    mean /= this.win.length;
    let v = 0;
    for (const w of this.win) {
      v += (w.m - mean) ** 2;
    }
    const std = Math.sqrt(v / this.win.length);
    const still =
      this.win.length >= 5 &&
      std < this.p.zuptStd &&
      Math.abs(mean - G) < this.p.zuptMean;

    const a = rotate(this.q, [x, y, z]);
    if (still) {
      if (!this.still) {
        this.zupts++;
      }
      this.ve = 0;
      this.vn = 0;
      const k = this.p.biasAlpha;
      this.bias[0] += k * (a[0] - this.bias[0]);
      this.bias[1] += k * (a[1] - this.bias[1]);
    } else {
      const ae = a[0] - this.bias[0];
      const an = a[1] - this.bias[1];
      const de = this.ve * dt + 0.5 * ae * dt * dt;
      const dn = this.vn * dt + 0.5 * an * dt * dt;
      this.e += de;
      this.n += dn;
      this.distance += Math.hypot(de, dn);
      this.ve += ae * dt;
      this.vn += an * dt;
    }
    this.still = still;
    if (t - this.lastOut >= 1 / this.p.outHz) {
      this.lastOut = t;
      this.track.push({ t, e: this.e, n: this.n });
    }
  }

  get speed() {
    return Math.hypot(this.ve, this.vn);
  }
}
