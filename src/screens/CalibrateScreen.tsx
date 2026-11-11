import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { dlog } from '../../debugLog';
import RecordingPanel from './RecordingPanel';
import {
  Availability,
  BiasEstimator,
  ImuBatch,
  RecordingStatus,
  Vec3,
  compassPoint,
  count,
  getAvailability,
  headingFromQuat,
  imuAvailable,
  lastVec,
  norm,
  startImu,
} from '../sensors/imu';

const RATE_HZ = 100;
const BIAS_SECONDS = 10;
const MAG_ACC = ['UNRELIABLE', 'LOW', 'MEDIUM', 'HIGH'];

type Live = {
  acc?: Vec3;
  gyr?: Vec3;
  mag?: Vec3;
  heading?: number;
  magAccuracy: number;
  hz: { acc: number; gyr: number; mag: number; rot: number };
  gpsAcc?: number;
  sats: number;
  recording?: RecordingStatus;
};

/** GPS is the ground-truth track; ask before the sensors start. */
async function requestLocation() {
  if (Platform.OS !== 'android') {
    return;
  }
  const res = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ]);
  dlog(`location permission: ${JSON.stringify(res)}`);
}

const f = (n: number | undefined, d = 3) =>
  n == null ? '—' : n.toFixed(d).padStart(d + 4);

export default function CalibrateScreen() {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live>({
    magAccuracy: -1,
    sats: -1,
    hz: { acc: 0, gyr: 0, mag: 0, rot: 0 },
  });
  const [ready, setReady] = useState(false);
  const [bias, setBias] = useState<Vec3 | null>(null);
  const [biasLeft, setBiasLeft] = useState<number | null>(null);
  const biasRef = useRef<BiasEstimator | null>(null);

  useEffect(() => {
    if (!imuAvailable()) {
      setError('ImuSensors native module not available (rebuild the app).');
      return;
    }
    let stop: (() => Promise<void>) | null = null;
    let cancelled = false;
    // Sample counts over the last second for the rate readout.
    const window: { t: number; c: Live['hz'] }[] = [];

    getAvailability().then(setAvail, e => setError(String(e?.message ?? e)));
    let lastMagAcc = -2;
    requestLocation()
      .catch(e => dlog(`location permission request failed: ${e}`))
      .then(() =>
        startImu(RATE_HZ, (b: ImuBatch) => {
          if (b.magAccuracy !== lastMagAcc) {
            dlog(
              `magnetometer accuracy ${
                MAG_ACC[b.magAccuracy] ?? b.magAccuracy
              }`,
            );
            lastMagAcc = b.magAccuracy;
          }
          biasRef.current?.add(b.gyr);
          const now = Date.now();
          window.push({
            t: now,
            c: {
              acc: count(b.acc),
              gyr: count(b.gyr),
              mag: count(b.mag),
              rot: count(b.rot, 5),
            },
          });
          while (window.length && now - window[0].t > 1000) {
            window.shift();
          }
          const hz = { acc: 0, gyr: 0, mag: 0, rot: 0 };
          for (const w of window) {
            hz.acc += w.c.acc;
            hz.gyr += w.c.gyr;
            hz.mag += w.c.mag;
            hz.rot += w.c.rot;
          }
          const r = b.rot;
          const n = r.length;
          setLive(prev => ({
            acc: lastVec(b.acc) ?? prev.acc,
            gyr: lastVec(b.gyr) ?? prev.gyr,
            mag: lastVec(b.mag) ?? prev.mag,
            heading:
              n >= 5
                ? headingFromQuat(r[n - 4], r[n - 3], r[n - 2], r[n - 1])
                : prev.heading,
            magAccuracy: b.magAccuracy,
            hz,
            gpsAcc: b.gps.length >= 5 ? b.gps[b.gps.length - 2] : prev.gpsAcc,
            sats: b.sats,
            recording: b.recording,
          }));
        }),
      )
      .then(
        s => {
          if (cancelled) {
            s();
          } else {
            stop = s;
            setReady(true);
          }
        },
        e => setError(String(e?.message ?? e)),
      );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  function captureBias() {
    biasRef.current = new BiasEstimator();
    setBias(null);
    let left = BIAS_SECONDS;
    setBiasLeft(left);
    const iv = setInterval(() => {
      left -= 1;
      setBiasLeft(left);
      if (left <= 0) {
        clearInterval(iv);
        const m = biasRef.current?.mean() ?? null;
        setBias(m);
        dlog(`gyro bias captured: ${JSON.stringify(m)}`);
        biasRef.current = null;
        setBiasLeft(null);
      }
    }, 1000);
  }

  const magOk = live.magAccuracy >= 2;
  const magNorm = live.mag ? norm(live.mag) : undefined;
  // Earth's field is ~25–65 µT; outside that something nearby is distorting it.
  const magDisturbed = magNorm != null && (magNorm < 20 || magNorm > 70);

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Calibration</Text>
      {error && <Text style={s.err}>{error}</Text>}

      <RecordingPanel
        status={live.recording}
        gpsAcc={live.gpsAcc}
        sats={live.sats}
        sensorsReady={ready}
        meta={() => ({
          rateHz: RATE_HZ,
          gyroBias: bias,
          magAccuracy: live.magAccuracy,
          heading: live.heading ?? null,
        })}
      />

      <View style={s.card}>
        <Text style={s.h2}>
          Gyro bias{' '}
          {bias ? (
            <Text style={s.ok}>✓ {norm(bias).toFixed(4)} rad/s</Text>
          ) : (
            <Text style={s.dim}>not captured</Text>
          )}
        </Text>
        {bias && (
          <Text style={s.mono}>
            x {f(bias[0], 4)} y {f(bias[1], 4)} z {f(bias[2], 4)}
          </Text>
        )}
        <Button
          title={
            biasLeft != null
              ? `Hold still… ${biasLeft}s`
              : `Hold still ${BIAS_SECONDS} s`
          }
          disabled={biasLeft != null || !!error}
          onPress={captureBias}
        />
      </View>

      <View style={s.card}>
        <Text style={s.h2}>
          Magnetometer{' '}
          <Text style={magOk && !magDisturbed ? s.ok : s.warn}>
            {magOk ? '✓' : '⚠'} accuracy{' '}
            {MAG_ACC[live.magAccuracy] ?? 'UNKNOWN'}
          </Text>
        </Text>
        {!magOk && (
          <Text style={s.dim}>Wave the phone in a figure-8 until HIGH.</Text>
        )}
        {magDisturbed && (
          <Text style={s.warn}>
            Field {magNorm?.toFixed(0)} µT is outside 20–70 µT: move away from
            metal or electronics.
          </Text>
        )}
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Heading</Text>
        <Text style={s.big}>
          {live.heading == null
            ? '—'
            : `${live.heading.toFixed(0).padStart(3, '0')}° ${compassPoint(
                live.heading,
              )}`}
        </Text>
        <Text style={s.dim}>Magnetic, from the fused rotation vector.</Text>
      </View>

      <View style={s.card}>
        <Text style={s.h2}>Live</Text>
        <Text style={s.mono}>
          acc m/s² {f(live.acc?.[0], 2)} {f(live.acc?.[1], 2)}{' '}
          {f(live.acc?.[2], 2)}
          {'\n'}gyr rad/s {f(live.gyr?.[0])} {f(live.gyr?.[1])}{' '}
          {f(live.gyr?.[2])}
          {'\n'}mag µT {f(live.mag?.[0], 1)} {f(live.mag?.[1], 1)}{' '}
          {f(live.mag?.[2], 1)} |m| {f(magNorm, 1)}
        </Text>
        <Text style={[s.mono, s.dim]}>
          rate Hz acc {live.hz.acc} gyr {live.hz.gyr} mag {live.hz.mag} rot{' '}
          {live.hz.rot}
        </Text>
      </View>

      {avail && (
        <View style={s.card}>
          <Text style={s.h2}>Sensors on this phone</Text>
          {(Object.keys(avail) as (keyof Availability)[]).map(k => {
            const a = avail[k];
            return (
              <Text key={k} style={s.mono}>
                {k}{' '}
                {a ? `${a.name} · max ${a.maxHz.toFixed(0)} Hz` : '✗ missing'}
              </Text>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  h1: { fontSize: 22, fontWeight: '700' },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  card: { padding: 12, borderRadius: 8, backgroundColor: '#f2f2f2', gap: 6 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  big: { fontSize: 32, fontWeight: '700', fontFamily: 'monospace' },
  ok: { color: '#1b7f3b' },
  warn: { color: '#b26a00' },
  dim: { color: '#666' },
  err: { color: '#b00020' },
});
