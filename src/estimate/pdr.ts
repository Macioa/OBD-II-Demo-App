import { headingFromQuat } from '../sensors/imu';

/**
 * Pedestrian dead reckoning. Pure and streaming: feed the same samples live
 * or from a recording and get the same path.
 *
 * Steps: |acc| is low-passed, each peak above `peakMin` (m/s² over gravity)
 * followed by a trough is one step, if it lands 0.25–2 s after the last one.
 * Length: Weinberg, K·(amax − amin)^¼. Heading: the rotation vector's yaw of
 * the phone's top edge (phone held flat, pointing the way you walk).
 */
export type PdrParams = {
  peakMin: number; // m/s² above g a peak must reach
  troughMax: number; // m/s² relative to g the following trough must dip to
  minStepS: number;
  maxStepS: number;
  weinbergK: number;
  lowPassHz: number;
  headingOffsetDeg: number; // phone-to-walking-direction offset
  /** OBD speed above this (km/h), seen in the last vehicleStaleS, means driving: no steps. */
  vehicleKmh: number;
  vehicleStaleS: number;
};

export const DEFAULT_PDR: PdrParams = {
  peakMin: 1.2,
  troughMax: -0.6,
  minStepS: 0.25,
  maxStepS: 2.0,
  weinbergK: 0.48,
  lowPassHz: 3,
  headingOffsetDeg: 0,
  vehicleKmh: 0,
  vehicleStaleS: 6,
};

export type Step = {
  t: number;
  e: number;
  n: number;
  len: number;
  heading: number;
};

const G = 9.80665;

export class Pdr {
  readonly p: PdrParams;
  steps: Step[] = [];
  e = 0;
  n = 0;
  distance = 0;
  heading: number | null = null;

  private lp: number | null = null;
  private lastT: number | null = null;
  private lastStepT = -Infinity;
  private state: 'idle' | 'peak' = 'idle';
  private peakVal = 0;
  private peakT = 0;
  private minSince = 0;
  private kmh = 0;
  private kmhT = -Infinity;
  /** Steps rejected because OBD said the car was moving. */
  gated = 0;

  constructor(params: Partial<PdrParams> = {}) {
    this.p = { ...DEFAULT_PDR, ...params };
  }

  /** OBD vehicle speed (M5 gate): car vibration must not count as steps. */
  addSpeed(t: number, kmh: number) {
    this.kmh = kmh;
    this.kmhT = t;
  }

  /** Flat stride-5 [t, qx, qy, qz, qw, ...]. */
  addRot(rot: number[]) {
    for (let i = 0; i + 4 < rot.length; i += 5) {
      this.heading = headingFromQuat(
        rot[i + 1],
        rot[i + 2],
        rot[i + 3],
        rot[i + 4],
      );
    }
  }

  /** Flat stride-4 [t, x, y, z, ...]. Returns steps added. */
  addAcc(acc: number[]): Step[] {
    const out: Step[] = [];
    for (let i = 0; i + 3 < acc.length; i += 4) {
      const s = this.sample(acc[i], acc[i + 1], acc[i + 2], acc[i + 3]);
      if (s) {
        out.push(s);
      }
    }
    return out;
  }

  sample(t: number, x: number, y: number, z: number): Step | null {
    const a = Math.hypot(x, y, z) - G;
    if (this.lp == null || this.lastT == null) {
      this.lp = a;
      this.lastT = t;
      return null;
    }
    const dt = Math.max(0, t - this.lastT);
    this.lastT = t;
    const alpha = 1 - Math.exp(-2 * Math.PI * this.p.lowPassHz * dt);
    this.lp += alpha * (a - this.lp);
    const v = this.lp;

    if (this.state === 'idle') {
      if (v > this.p.peakMin) {
        this.state = 'peak';
        this.peakVal = v;
        this.peakT = t;
        this.minSince = v;
      }
      return null;
    }
    // In a peak: track the max, then the trough that follows it.
    if (v > this.peakVal && this.minSince === this.peakVal) {
      this.peakVal = v;
      this.peakT = t;
      this.minSince = v;
    }
    this.minSince = Math.min(this.minSince, v);
    if (t - this.peakT > this.p.maxStepS) {
      this.state = 'idle'; // no trough: not a step
      return null;
    }
    if (this.minSince > this.p.troughMax) {
      return null;
    }
    this.state = 'idle';
    const gap = this.peakT - this.lastStepT;
    if (gap < this.p.minStepS) {
      return null;
    }
    this.lastStepT = this.peakT;
    if (
      this.kmh > this.p.vehicleKmh &&
      this.peakT - this.kmhT <= this.p.vehicleStaleS
    ) {
      this.gated++;
      return null;
    }
    const len = this.p.weinbergK * Math.pow(this.peakVal - this.minSince, 0.25);
    const hdg = ((this.heading ?? 0) + this.p.headingOffsetDeg + 360) % 360;
    const h = (hdg * Math.PI) / 180;
    this.e += len * Math.sin(h);
    this.n += len * Math.cos(h);
    this.distance += len;
    const step = { t: this.peakT, e: this.e, n: this.n, len, heading: hdg };
    this.steps.push(step);
    return step;
  }

  /** Steps per second over the last `windowS` seconds ending at t. */
  cadence(t: number, windowS = 4) {
    let c = 0;
    for (
      let i = this.steps.length - 1;
      i >= 0 && this.steps[i].t > t - windowS;
      i--
    ) {
      c++;
    }
    return c / windowS;
  }
}
