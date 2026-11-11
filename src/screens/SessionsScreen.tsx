import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { dlog, dlogError } from '../../debugLog';
import { parseObdSpeeds } from '../estimate/wheel';
import {
  ENGINES,
  EngineId,
  GpsFix,
  Replay,
  frameAt,
  parseGps,
  parseImu,
  replay,
  startMs,
  toCsv,
  toGpx,
} from '../session/replay';
import {
  RecordingInfo,
  deleteRecording,
  listRecordings,
  loadRecording,
  shareExports,
} from '../sensors/imu';
import TrackMap from './TrackMap';

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
export const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const m = (x: number | null) => (x == null ? '—' : `${x.toFixed(1)} m`);
const SPEEDS = [1, 8, 32] as const;
const pad = (x: number | null) => (x == null ? '—' : x.toFixed(0)).padStart(7);
const TICK_MS = 100;

/** M4: saved sessions list → replay with map, scrubber, stats and export. */
export default function SessionsScreen({ active }: { active?: boolean }) {
  const [list, setList] = useState<RecordingInfo[]>([]);
  const [open, setOpen] = useState<RecordingInfo | null>(null);

  const refresh = useCallback(() => {
    listRecordings().then(setList, e => dlogError('listRecordings', e));
  }, []);
  // Screens stay mounted; refresh whenever this tab is shown.
  useEffect(() => {
    if (active !== false) {
      refresh();
    }
  }, [active, refresh]);

  if (open) {
    return (
      <SessionDetail
        info={open}
        onBack={() => {
          setOpen(null);
          refresh();
        }}
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.head}>
        <Text style={s.h1}>Sessions</Text>
        <Button title="↻ Refresh" onPress={refresh} />
      </View>
      {list.length === 0 && (
        <Text style={s.dim}>
          No recordings yet. Start one on the Calibrate tab.
        </Text>
      )}
      {list.map(r => (
        <Pressable
          key={r.id}
          testID={`session-${r.id}`}
          style={s.item}
          disabled={r.active}
          onPress={() => setOpen(r)}
        >
          <Text style={s.itemTitle}>{r.id.replace('rec-', '')}</Text>
          <Text style={s.dim}>
            {r.active
              ? '● recording…'
              : `${r.durationS < 0 ? 'unfinished' : clock(r.durationS)} · ${mb(
                  r.bytes,
                )} · ${r.gpsFixes} GPS fixes`}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

type Loaded = { r: Replay; fixes: GpsFix[]; startedAt?: string };

function SessionDetail({
  info,
  onBack,
}: {
  info: RecordingInfo;
  onBack: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(8);
  const [barW, setBarW] = useState(1);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<EngineId>('pdr');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let live = true;
    const started = Date.now();
    loadRecording(info.id)
      .then(f => {
        const fixes = parseGps(f.gps);
        const r = replay(
          fixes,
          parseImu(f.imu),
          {},
          parseObdSpeeds(f.events ?? ''),
        );
        let meta: { startedAt?: string } = {};
        try {
          meta = JSON.parse(f.meta);
        } catch {}
        dlog(
          `sessions: replayed ${info.id} in ${Date.now() - started} ms steps=${
            r.steps
          } fixes=${fixes.length} obd=${r.obdSpeeds} ${r.engines
            .map(x => `${x.id}Max=${x.stats.max?.toFixed(1)}`)
            .join(' ')}`,
        );
        if (live) {
          setData({ r, fixes, startedAt: meta.startedAt });
          // A drive with OBD speed: the wheel estimate is the one to look at.
          setEngine(r.obdSpeeds ? 'wheel' : 'pdr');
          setT(r.tEnd);
        }
      })
      .catch(e => {
        dlogError('loadRecording', e);
        live && setError(String(e?.message ?? e));
      });
    return () => {
      live = false;
    };
  }, [info.id]);

  // Playback clock: advance t by speed × real time; stop at the end.
  useEffect(() => {
    if (!playing || !data) {
      return;
    }
    timer.current = setInterval(() => {
      setT(x => {
        const nx = x + (speed * TICK_MS) / 1000;
        if (nx >= data.r.tEnd) {
          setPlaying(false);
          return data.r.tEnd;
        }
        return nx;
      });
    }, TICK_MS);
    return () => {
      timer.current && clearInterval(timer.current);
    };
  }, [playing, speed, data]);

  async function exportFiles(kind: 'gpx' | 'csv' | 'both') {
    if (!data) {
      return;
    }
    setBusy(true);
    try {
      const files: Record<string, string> = {};
      if (kind !== 'csv') {
        files[`${info.id}.gpx`] = toGpx(
          data.r,
          info.id,
          data.fixes,
          startMs(data.startedAt),
        );
      }
      if (kind !== 'gpx') {
        files[`${info.id}-${engine}-error.csv`] = toCsv(data.r, engine);
      }
      await shareExports(info.id, files);
      dlog(`sessions: exported ${Object.keys(files).join(', ')}`);
    } catch (e: any) {
      dlogError('shareExports', e);
      Alert.alert('Export failed', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    Alert.alert('Delete session?', `${info.id} will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          deleteRecording(info.id).then(onBack, e => dlogError('delete', e)),
      },
    ]);
  }

  const header = (
    <View style={s.head}>
      <Button title="← Back" onPress={onBack} />
      <Text style={[s.h2, s.grow]} numberOfLines={1}>
        {info.id.replace('rec-', '')}
      </Text>
    </View>
  );

  if (error) {
    return (
      <View style={s.page}>
        {header}
        <Text style={s.err}>Could not load: {error}</Text>
      </View>
    );
  }
  if (!data) {
    return (
      <View style={s.page}>
        {header}
        <ActivityIndicator />
        <Text style={s.dim}>Replaying sensor data…</Text>
      </View>
    );
  }

  const { r } = data;
  const span = Math.max(r.tEnd - r.t0, 1e-6);
  const f = frameAt(r, t, engine);
  const main = r.engines.find(x => x.id === engine) ?? r.engines[0];
  const frac = Math.min(1, Math.max(0, (t - r.t0) / span));

  return (
    <View style={s.page}>
      {header}
      <View style={s.mapBox}>
        {r.origin ? (
          <TrackMap
            origin={r.origin}
            est={f.est}
            gps={f.gps}
            links={f.links}
            cur={f.cur}
            focus={f.focus}
            showGps
            others={f.others}
            estColor={ENGINES[main.id].color}
          />
        ) : (
          <Text style={s.dim}>No GPS fix in this session: nothing to map.</Text>
        )}
      </View>

      <View style={s.row}>
        <Button
          testID="replay-play"
          title={playing ? '❚❚' : '▶'}
          onPress={() => {
            if (!playing && t >= r.tEnd) {
              setT(r.t0);
            }
            setPlaying(!playing);
          }}
        />
        <Pressable
          testID="replay-bar"
          style={s.bar}
          onLayout={e => setBarW(e.nativeEvent.layout.width || 1)}
          onPress={e => {
            setPlaying(false);
            setT(r.t0 + (e.nativeEvent.locationX / barW) * span);
          }}
        >
          <View style={[s.barFill, { width: `${frac * 100}%` }]} />
        </Pressable>
        <Text style={s.mono}>
          {clock(t - r.t0)}/{clock(span)}
        </Text>
      </View>
      <View style={s.row}>
        {SPEEDS.map(x => (
          <Pressable
            key={x}
            style={[s.chip, speed === x && s.chipOn]}
            onPress={() => setSpeed(x)}
          >
            <Text style={speed === x ? s.chipOnTxt : undefined}>{x}×</Text>
          </Pressable>
        ))}
        <Text style={[s.mono, s.grow]}> err now {m(f.err)}</Text>
      </View>

      <View style={s.row}>
        {r.engines.map(x => (
          <Pressable
            key={x.id}
            testID={`engine-${x.id}`}
            style={[s.chip, engine === x.id && s.chipOn]}
            onPress={() => setEngine(x.id)}
          >
            <Text
              style={
                engine === x.id ? s.chipOnTxt : { color: ENGINES[x.id].color }
              }
            >
              ● {ENGINES[x.id].label}
            </Text>
          </Pressable>
        ))}
        {!r.obdSpeeds && <Text style={s.dim}>no OBD speed → no wheel</Text>}
      </View>
      <Text style={s.mono} testID="replay-stats">
        {'       DIST   FINAL    MAX   MEAN  ERR/D'}
        {r.engines.map(
          x =>
            `\n${ENGINES[x.id].label.padEnd(5)}${pad(x.dist)}${pad(
              x.stats.cur,
            )}${pad(x.stats.max)}${pad(x.stats.mean)}${
              x.errPerDist == null
                ? '      —'
                : `${(x.errPerDist * 100).toFixed(1)}%`.padStart(7)
            }`,
        )}
        {`\nGPS${pad(r.gpsDist)}  │ STEPS ${r.steps} │ FIXES ${
          data.fixes.length
        } │ OBD ${r.obdSpeeds}`}
      </Text>

      <View style={s.row}>
        <Button
          title="Export GPX"
          onPress={() => exportFiles('gpx')}
          disabled={busy}
        />
        <Button
          title="CSV"
          onPress={() => exportFiles('csv')}
          disabled={busy}
        />
        <Button
          title="Both"
          onPress={() => exportFiles('both')}
          disabled={busy}
        />
        <View style={s.grow} />
        <Button title="Delete" color="#c62828" onPress={remove} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flexGrow: 1, flex: 1, padding: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  h1: { fontSize: 20, fontWeight: '700', flex: 1 },
  h2: { fontSize: 16, fontWeight: '600' },
  dim: { color: '#666' },
  err: { color: '#c62828' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  item: { padding: 12, borderRadius: 8, backgroundColor: '#f2f2f2', gap: 2 },
  itemTitle: { fontWeight: '600' },
  mapBox: { flex: 1, minHeight: 200, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  bar: {
    flex: 1,
    height: 24,
    borderRadius: 4,
    backgroundColor: '#e0e0e0',
    overflow: 'hidden',
  },
  barFill: { height: '100%', backgroundColor: '#d84315' },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#eee',
  },
  chipOn: { backgroundColor: '#263238' },
  chipOnTxt: { color: '#fff', fontWeight: '700' },
});
