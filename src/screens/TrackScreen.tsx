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
import { Pdr } from '../estimate/pdr';
import { EN, pathLength, toEnu } from '../geo/enu';
import { errorStats } from '../geo/overlay';
import { ImuBatch, compassPoint, logEvent, onImuBatch } from '../sensors/imu';
import TrackMap from './TrackMap';

type Timed = EN & { t: number };
type Run = {
  pdr: Pdr;
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

  useEffect(
    () =>
      onImuBatch((b: ImuBatch) => {
        const r = run.current;
        if (!r) {
          return;
        }
        r.pdr.addRot(b.rot);
        const steps = r.pdr.addAcc(b.acc);
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
    run.current = { pdr: new Pdr(), gps: [], origin: null, t0: null, t: 0 };
    setActive(true);
    dlog('track: PDR started');
    logEvent('pdr start');
  }
  function stop() {
    const r = run.current;
    setActive(false);
    if (r) {
      dlog(
        `track: PDR stopped steps=${
          r.pdr.steps.length
        } dist=${r.pdr.distance.toFixed(1)}m`,
      );
      logEvent('pdr stop');
      // Stop feeding it but keep the result on screen.
      run.current = null;
      setFrozen(r);
    }
  }
  const r = run.current ?? frozen;

  const est: Timed[] = r ? [{ t: r.t0 ?? 0, e: 0, n: 0 }, ...r.pdr.steps] : [];
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
          {active ? '◉ PDR ' : 'Track '}
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
          cur={r.pdr}
          showGps={showGps}
        />
      ) : (
        <View style={s.plot} onLayout={onLayout}>
          <Text style={s.grid}>grid {gridStep} m · N↑</Text>
          {showGps &&
            thin(gps, MAX_DOTS).map((p, i) => (
              <View key={`g${i}`} style={[s.dot, s.gps, toXY(p)]} />
            ))}
          {thin(est, MAX_DOTS).map((p, i) => (
            <View key={`e${i}`} style={[s.dot, s.est, toXY(p)]} />
          ))}
          {r && <View style={[s.start, toXY({ e: 0, n: 0 })]} />}
          {r && <View style={[s.cur, toXY(r.pdr)]} />}
          {!r && (
            <Text style={s.hint}>
              Start, then walk holding the phone flat, top edge forward.
            </Text>
          )}
        </View>
      )}
      <View style={s.legend}>
        <Text style={s.gpsTxt}>● GPS</Text>
        <Text style={s.estTxt}>● PDR estimate</Text>
        {onMap && <Text style={s.dim}>┄ error / 5 s</Text>}
      </View>

      <View style={s.hud}>
        <Text style={s.mono}>
          DIST EST {(r?.pdr.distance ?? 0).toFixed(0)} m │ GPS{' '}
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
          {r?.pdr.heading != null
            ? `${r.pdr.heading.toFixed(0).padStart(3, '0')}° ${compassPoint(
                r.pdr.heading,
              )}`
            : '—'}{' '}
          │ STEPS {r?.pdr.steps.length ?? 0} ·{' '}
          {r ? r.pdr.cadence(r.t).toFixed(1) : '0.0'}/s
        </Text>
      </View>
      <Button
        title={active ? '■ Stop' : '▶ Start PDR'}
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
  est: { backgroundColor: '#d84315' },
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
  estTxt: { color: '#d84315' },
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
