import { NativeEventEmitter, NativeModules } from 'react-native';

/** Flat sample arrays from the native ImuSensors module (see SensorModule.kt). */
export type ImuBatch = {
  acc: number[]; // [t, x, y, z, ...] m/s², includes gravity
  gyr: number[]; // [t, x, y, z, ...] rad/s
  mag: number[]; // [t, x, y, z, ...] µT
  rot: number[]; // [t, qx, qy, qz, qw, ...] device→world (ENU)
  gps: number[]; // [t, lat, lon, accuracyM, sats, ...]
  magAccuracy: number; // SensorManager.SENSOR_STATUS_*: -1 unknown, 0 unreliable … 3 high
  sats: number; // satellites used in the last fix, -1 unknown
  recording?: RecordingStatus;
};

export type RecordingStatus = {
  id: string;
  elapsedS: number;
  bytes: number;
  accRows: number;
  gpsFixes: number;
};

export type RecordingInfo = {
  id: string;
  active: boolean;
  bytes: number;
  durationS: number; // -1 if the session never stopped cleanly
  startedAt: string;
  gpsFixes: number;
  accRows: number;
};

export type SensorInfo = { name: string; vendor: string; maxHz: number } | null;
export type Availability = Record<'acc' | 'gyr' | 'mag' | 'rot', SensorInfo>;

type Native = {
  getAvailability(): Promise<Availability>;
  start(rateHz: number): Promise<number>;
  stop(): Promise<boolean>;
  startRecording(meta: object): Promise<string>;
  stopRecording(meta: object): Promise<string | null>;
  logEvent(msg: string): void;
  listRecordings(): Promise<RecordingInfo[]>;
  shareRecording(
    id: string,
    extraLog: string,
  ): Promise<{ parts: number; mb: number }>;
  deleteRecording(id: string): Promise<boolean>;
  loadRecording(id: string): Promise<RecordingFiles>;
  shareExports(id: string, files: Record<string, string>): Promise<number>;
};

/** Raw session text for replay (imu holds only a/r rows). */
export type RecordingFiles = { meta: string; gps: string; imu: string };

const native = NativeModules.ImuSensors as Native | undefined;
const emitter = native
  ? new NativeEventEmitter(NativeModules.ImuSensors)
  : null;

export const imuAvailable = () => native != null;

export function getAvailability(): Promise<Availability> {
  if (!native) {
    return Promise.reject(new Error('ImuSensors native module not available'));
  }
  return native.getAvailability();
}

/**
 * Starts streaming and calls onBatch roughly every 100 ms.
 * Returns an async unsubscribe that also stops the sensors.
 */
export async function startImu(
  rateHz: number,
  onBatch: (b: ImuBatch) => void,
): Promise<() => Promise<void>> {
  if (!native || !emitter) {
    throw new Error('ImuSensors native module not available');
  }
  const sub = emitter.addListener('imuBatch', e => onBatch(e as ImuBatch));
  await native.start(rateHz);
  return async () => {
    sub.remove();
    await native.stop();
  };
}

/**
 * Listen to the stream another screen started (Calibrate owns start/stop).
 * Returns an unsubscribe; never stops the sensors.
 */
export function onImuBatch(cb: (b: ImuBatch) => void): () => void {
  if (!emitter) {
    return () => {};
  }
  const sub = emitter.addListener('imuBatch', e => cb(e as ImuBatch));
  return () => sub.remove();
}

function need(): Native {
  if (!native) {
    throw new Error('ImuSensors native module not available');
  }
  return native;
}

/** Sensors must be running (startImu) first. Resolves with the session id. */
export const startRecording = (meta: object) => need().startRecording(meta);
export const stopRecording = (meta: object = {}) => need().stopRecording(meta);
export const listRecordings = () => need().listRecordings();
export const shareRecording = (id: string, extraLog: string) =>
  need().shareRecording(id, extraLog);
export const deleteRecording = (id: string) => need().deleteRecording(id);
export const loadRecording = (id: string) => need().loadRecording(id);
export const shareExports = (id: string, files: Record<string, string>) =>
  need().shareExports(id, files);

/** Append to the active recording's events.log; silently ignored when idle. */
export function logEvent(msg: string) {
  native?.logEvent(msg);
}

export type Vec3 = [number, number, number];

/** Last [x, y, z] in a flat stride-4 stream, or null. */
export function lastVec(a: number[]): Vec3 | null {
  return a.length >= 4
    ? [a[a.length - 3], a[a.length - 2], a[a.length - 1]]
    : null;
}

/** Iterate [x,y,z] samples in a flat stride-4 stream. */
export function* vecs(a: number[]): Generator<Vec3> {
  for (let i = 0; i + 3 < a.length; i += 4) {
    yield [a[i + 1], a[i + 2], a[i + 3]];
  }
}

/** Sample count in a flat stream with the given stride. */
export const count = (a: number[], stride = 4) => Math.floor(a.length / stride);

export const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/**
 * Compass heading (0–360°, clockwise from magnetic north) of the phone's
 * top edge (+Y axis), from a device→world ENU quaternion.
 */
export function headingFromQuat(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
) {
  const east = 2 * (qx * qy - qz * qw);
  const north = 1 - 2 * (qx * qx + qz * qz);
  const deg = (Math.atan2(east, north) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compassPoint = (deg: number) => DIRS[Math.round(deg / 45) % 8];

/** Running mean of gyro samples while the phone is held still. */
export class BiasEstimator {
  private sum: Vec3 = [0, 0, 0];
  n = 0;
  add(a: number[]) {
    for (const v of vecs(a)) {
      this.sum[0] += v[0];
      this.sum[1] += v[1];
      this.sum[2] += v[2];
      this.n++;
    }
  }
  mean(): Vec3 | null {
    if (!this.n) {
      return null;
    }
    return [this.sum[0] / this.n, this.sum[1] / this.n, this.sum[2] / this.n];
  }
}
