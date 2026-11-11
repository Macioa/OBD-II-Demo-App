import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { dlog } from '../../debugLog';
import { Ins } from '../estimate/ins';
import { Pdr } from '../estimate/pdr';
import { Wheel } from '../estimate/wheel';
import { onObdSpeed, useObd } from '../obd/session';
import { ENGINES, EngineId } from '../session/replay';
import { EN, pathLength, toEnu } from '../geo/enu';
import { errorStats } from '../geo/overlay';
import { ImuBatch, compassPoint, logEvent, onImuBatch } from '../sensors/imu';
import TrackMap from './TrackMap';

type Timed = EN & { t: number };
type Run = {
  pdr: Pdr;
  ins: Ins;
  wheel: Wheel;
  gps: Timed[];
  origin: { lat: number; lon: number } | null;
  t0: number | null;
  t: number;
};

const MAX_DOTS = 400;

function thin<T>(a: T[], max: number) {
  if (a.length <= max) {
    return a;
  }
  const k = a.length / max;
  return Array.from({ length: max }, (_, i) => a[Math.floor(i * k)]).concat(
    a[a.length - 1],
  );
}

/** PDR path vs GPS path: offline map (M3) or local metric grid. */
export default function TrackScreen() {
  const run = useRef<Run | null>(null);
  const [, setTick] = useState(0);
  const [active, setActive] = useState(false);
  const [gpsDenied, setGpsDenied] = useState(false);
  const [size, setSize] = useState({ w: 300, h: 300 });
  const [frozen, setFrozen] = useState<Run | null>(null);
  const [view, setView] = useState<'map' | 'grid'>('map');
  const [engine, setEngine] = useState<EngineId>('pdr');
  const obd = useObd();

  // OBD speed → wheel engine, stamped on the IMU clock.
  useEffect(
    () =>
      onObdSpeed(kmh => {
        const r = run.current;
        if (r && r.t0 != null) {
          r.wheel.addSpeed(r.t, kmh);
          r.pdr.addSpeed(r.t, kmh);
        }
      }),
    [],
  );

  useEffect(
    () =>
      onImuBatch((b: ImuBatch) => {
        const r = run.current;
        if (!r) {
          return;
        }
        r.pdr.addRot(b.rot);
        r.ins.addRot(b.rot);
        r.wheel.addRot(b.rot);
        const steps = r.pdr.addAcc(b.acc);
        r.ins.addAcc(b.acc);
        r.wheel.addAcc(b.acc);
        if (b.acc.length) {
          r.t = b.acc[b.acc.length - 4];
          r.t0 ??= b.acc[0];
        }
        for (let i = 0; i + 4 < b.gps.length; i += 5) {
          const [t, lat, lon] = b.gps.slice(i, i + 3);
          if (!r.origin) {
            r.origin = { lat, lon };
            dlog(`track: GPS anchor ${lat.toFixed(6)},${lon.toFixed(6)}`);
          }
          r.gps.push({ t, ...toEnu(lat, lon, r.origin.lat, r.origin.lon) });
        }
        if (steps.length) {
          logEvent(
            `pdr steps=${r.pdr.steps.length} e=${r.pdr.e.toFixed(
              1,
            )} n=${r.pdr.n.toFixed(1)}`,
          );
        }
        setTick(x => x + 1);
      }),
    [],
  );

  function start() {
    run.current = {
      pdr: new Pdr(),
      ins: new Ins(),
      wheel: new Wheel(),
      gps: [],
      origin: null,
      t0: null,
      t: 0,
    };
    setActive(true);
    dlog(`track: started (main ${engine})`);
    logEvent('pdr start');
  }
  function stop() {
    const r = run.current;
    setActive(false);
    if (r) {
      dlog(
        `track: PDR stopped steps=${
          r.pdr.steps.length
        } dist=${r.pdr.distance.toFixed(1)}m ins=${r.ins.distance.toFixed(
          1,
        )}m wheel=${r.wheel.distance.toFixed(1)}m speeds=${r.wheel.speeds}`,
      );
      logEvent('pdr stop');
      // Stop feeding it but keep the result on screen.
      run.current = null;
      setFrozen(r);
    }
  }
  const r = run.current ?? frozen;

  const tracks: Record<EngineId, Timed[]> = {
    pdr: r ? [{ t: r.t0 ?? 0, e: 0, n: 0 }, ...r.pdr.steps] : [],
    ins: r?.ins.track ?? [],
    wheel: r?.wheel.speeds ? r.wheel.track() : [],
  };
  const est: Timed[] = tracks[engine];
  const dists: Record<EngineId, number> = {
    pdr: r?.pdr.distance ?? 0,
    ins: r?.ins.distance ?? 0,
    wheel: r?.wheel.distance ?? 0,
  };
  const ids = Object.keys(ENGINES) as EngineId[];
  const others = ids
    .filter(k => k !== engine && tracks[k].length)
    .map(k => ({ id: k, color: ENGINES[k].color, pts: thin(tracks[k], 2000) }));
  const curPt = est.length ? est[est.length - 1] : { e: 0, n: 0 };
  const heading =
    engine === 'wheel' ? r?.wheel.heading ?? null : r?.pdr.heading ?? null;
  const gps = r?.gps ?? [];
  const showGps = !(active && gpsDenied);
  const gpsDist = pathLength(gps);
  const stats = r && r.t0 != null ? errorStats(est, gps, r.t0, r.t) : null;
  const err = stats?.cur ?? null;
  const links = stats?.series ?? [];
  const onMap = view === 'map' && r?.origin != null;
  const elapsed = r && r.t0 != null ? r.t - r.t0 : 0;

  // Fit everything (with ≥20 m span) into the plot, north up, equal scale.
  const pts = showGps ? [...est, ...gps] : est;
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
  const span = Math.max(20, maxE - minE, maxN - minN) * 1.15;
  const cx = (minE + maxE) / 2;
  const cy = (minN + maxN) / 2;
  const px = Math.min(size.w, size.h) / span;
  const toXY = (p: EN) => ({
    left: size.w / 2 + (p.e - cx) * px,
    top: size.h / 2 - (p.n - cy) * px,
  });
  const gridStep =
    [5, 10, 20, 50, 100, 200, 500, 1000, 2000].find(g => span / g <= 8) ?? 5000;

  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  return (
    <View style={s.page}>
      <View style={s.top}>
        <Text style={s.h1}>
          {active ? `◉ ${ENGINES[engine].label} ` : 'Track '}
          <Text style={s.mono}>{fmtTime(elapsed)}</Text>
        </Text>
        <View style={s.row}>
          <Text style={s.dim}>GPS-denied </Text>
          <Switch value={gpsDenied} onValueChange={setGpsDenied} />
        </View>
      </View>

      <View style={s.row}>
        {(['map', 'grid'] as const).map(v => (
          <Pressable
            key={v}
            onPress={() => setView(v)}
            style={[s.seg, view === v && s.segOn]}
          >
            <Text>{v === 'map' ? 'Map' : 'Grid'}</Text>
          </Pressable>
        ))}
        {view === 'map' && !r?.origin && (
          <Text style={s.dim}> map needs a GPS fix — showing grid</Text>
        )}
      </View>

      {onMap && r?.origin ? (
        <TrackMap
          origin={r.origin}
          est={est}
          gps={gps}
          links={links.filter((_, i) => i % 5 === 0)}
          cur={curPt}
          focus={showGps && gps.length ? gps[gps.length - 1] : curPt}
          showGps={showGps}
          others={others}
          estColor={ENGINES[engine].color}
        />
      ) : (
        <View style={s.plot} onLayout={onLayout}>
          <Text style={s.grid}>grid {gridStep} m · N↑</Text>
          {showGps &&
            thin(gps, MAX_DOTS).map((p, i) => (
              <View key={`g${i}`} style={[s.dot, s.gps, toXY(p)]} />
            ))}
          {thin(est, MAX_DOTS).map((p, i) => (
            <View
              key={`e${i}`}
              style={[
                s.dot,
                { backgroundColor: ENGINES[engine].color },
                toXY(p),
              ]}
            />
          ))}
          {r && <View style={[s.start, toXY({ e: 0, n: 0 })]} />}
          {r && <View style={[s.cur, toXY(curPt)]} />}
          {!r && (
            <Text style={s.hint}>
              Start, then walk holding the phone flat, top edge forward.
            </Text>
          )}
        </View>
      )}
      <View style={s.legend}>
        <Text style={s.gpsTxt}>● GPS</Text>
        {ids.map(k => (
          <Pressable
            key={k}
            testID={`track-engine-${k}`}
            onPress={() => setEngine(k)}
          >
            <Text
              style={[{ color: ENGINES[k].color }, engine === k && s.engineOn]}
            >
              ● {ENGINES[k].label}
            </Text>
          </Pressable>
        ))}
        {onMap && <Text style={s.dim}>┄ error / 5 s</Text>}
      </View>

      <View style={s.hud}>
        <Text style={s.mono}>
          DIST EST {dists[engine].toFixed(0)} m │ GPS{' '}
          {showGps ? `${gpsDist.toFixed(0)} m` : 'hidden'}
          {'\n'}ERROR {showGps && err != null ? `${err.toFixed(1)} m` : '—'} │{' '}
          {showGps && err != null && gpsDist > 1
            ? `${((100 * err) / gpsDist).toFixed(1)} % of dist`
            : '—'}
          {'\n'}MAX ERR{' '}
          {showGps && stats?.max != null ? `${stats.max.toFixed(1)} m` : '—'} │
          MEAN{' '}
          {showGps && stats?.mean != null ? `${stats.mean.toFixed(1)} m` : '—'}
          {'\n'}HDG{' '}
          {heading != null
            ? `${heading.toFixed(0).padStart(3, '0')}° ${compassPoint(heading)}`
            : '—'}{' '}
          │ STEPS {r?.pdr.steps.length ?? 0} ·{' '}
          {r ? r.pdr.cadence(r.t).toFixed(1) : '0.0'}/s
          {'\n'}PDR {dists.pdr.toFixed(0)} │ INS {dists.ins.toFixed(0)}
          {r?.ins.still ? ' (still)' : ''} │ WHEEL{' '}
          {r?.wheel.speeds ? `${dists.wheel.toFixed(0)} m` : '—'}
          {'\n'}OBD{' '}
          {obd.status === 'reading'
            ? `${obd.live.kmh ?? '—'} km/h`
            : `${obd.status} (wheel needs OBD)`}{' '}
          │ AXIS {r?.wheel.learned ? `learned ×${r.wheel.learned}` : '—'}
        </Text>
      </View>
      <Button
        title={active ? '■ Stop' : '▶ Start'}
        onPress={active ? stop : start}
      />
    </View>
  );
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(
    2,
    '0',
  )}`;
}

const s = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 10 },
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  h1: { fontSize: 22, fontWeight: '700' },
  plot: {
    flex: 1,
    backgroundColor: '#f6f6f6',
    borderRadius: 8,
    overflow: 'hidden',
  },
  grid: { position: 'absolute', right: 8, top: 6, fontSize: 11, color: '#888' },
  hint: { margin: 24, marginTop: 80, textAlign: 'center', color: '#666' },
  dot: {
    position: 'absolute',
    width: 4,
    height: 4,
    marginLeft: -2,
    marginTop: -2,
    borderRadius: 2,
  },
  gps: { backgroundColor: '#1565c0' },
  start: {
    position: 'absolute',
    width: 10,
    height: 10,
    marginLeft: -5,
    marginTop: -5,
    borderRadius: 5,
    backgroundColor: '#000',
  },
  cur: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    marginTop: -6,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#d84315',
    backgroundColor: '#fff',
  },
  legend: { flexDirection: 'row', gap: 16 },
  gpsTxt: { color: '#1565c0' },
  engineOn: { fontWeight: '700', textDecorationLine: 'underline' },
  hud: { padding: 10, borderRadius: 8, backgroundColor: '#f2f2f2' },
  mono: { fontFamily: 'monospace', fontSize: 13 },
  dim: { color: '#666' },
  seg: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#ccc',
  },
  segOn: { backgroundColor: '#e0e0e0' },
});
