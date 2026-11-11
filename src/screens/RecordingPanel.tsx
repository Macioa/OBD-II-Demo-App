import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, StyleSheet, Text, View } from 'react-native';
import { buildReport, dlog, dlogError } from '../../debugLog';
import {
  RecordingInfo,
  RecordingStatus,
  deleteRecording,
  listRecordings,
  shareRecording,
  startRecording,
  stopRecording,
} from '../sensors/imu';

type Props = {
  /** Live status from the latest sensor batch; undefined when not recording. */
  status?: RecordingStatus;
  /** Latest GPS accuracy (m) and satellites, for the live readout. */
  gpsAcc?: number;
  sats: number;
  sensorsReady: boolean;
  /** Extra metadata saved into meta.json at start and stop. */
  meta: () => object;
};

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const dur = (s: number) =>
  s < 0
    ? 'unfinished'
    : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function RecordingPanel({
  status,
  gpsAcc,
  sats,
  sensorsReady,
  meta,
}: Props) {
  const [sessions, setSessions] = useState<RecordingInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listRecordings().then(setSessions, e => dlogError('listRecordings', e));
  }, []);
  useEffect(refresh, [refresh]);

  // Recording can outlive this screen; when it ends (or starts) refresh the list.
  const recId = status?.id;
  useEffect(refresh, [recId, refresh]);

  async function start() {
    setBusy(true);
    try {
      const id = await startRecording({ ...meta(), startReason: 'user' });
      dlog(`recording started ${id}`);
    } catch (e: any) {
      dlogError('startRecording', e);
      Alert.alert('Could not start recording', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      dlog('recording stop requested by user');
      await stopRecording({ ...meta(), stopReason: 'user' });
      refresh();
    } catch (e: any) {
      dlogError('stopRecording', e);
    } finally {
      setBusy(false);
    }
  }

  async function share(id: string) {
    setBusy(true);
    try {
      const r = await shareRecording(id, buildReport());
      dlog(`shared ${id}: ${r.parts} part(s), ${r.mb.toFixed(1)} MB`);
    } catch (e: any) {
      dlogError('shareRecording', e);
      Alert.alert('Could not share', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function remove(id: string) {
    Alert.alert('Delete recording?', `${id} will be permanently deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          deleteRecording(id).then(refresh, e => dlogError('delete', e)),
      },
    ]);
  }

  return (
    <View style={s.card}>
      <Text style={s.h2}>
        {status ? <Text style={s.rec}>● REC </Text> : null}Recording
      </Text>
      {status ? (
        <>
          <Text style={s.mono}>
            {dur(status.elapsedS)} · {mb(status.bytes)} ·{' '}
            {status.accRows.toLocaleString()} accel rows
            {'\n'}GPS {status.gpsFixes} fixes
            {gpsAcc != null
              ? ` · ±${gpsAcc.toFixed(0)} m`
              : ' · no fix yet'} · {sats >= 0 ? `${sats} sats` : 'sats ?'}
          </Text>
          <Text style={s.dim}>
            Keep the app open; the screen stays on while recording.
          </Text>
          <Button title="■ Stop recording" onPress={stop} disabled={busy} />
        </>
      ) : (
        <>
          <Text style={s.dim}>
            Saves every sensor sample, GPS fix and app event to the phone.
          </Text>
          <Button
            title="● Start recording"
            onPress={start}
            disabled={busy || !sensorsReady}
          />
        </>
      )}

      {sessions.length > 0 && <Text style={s.h3}>Saved sessions</Text>}
      {sessions.map(r => (
        <View key={r.id} style={s.row}>
          <Text style={[s.mono, s.grow]}>
            {r.id.replace('rec-', '')}
            {'\n'}
            {r.active
              ? 'recording…'
              : `${dur(r.durationS)} · ${mb(r.bytes)} · ${r.gpsFixes} GPS`}
          </Text>
          {!r.active && (
            <>
              <Button
                title="Email"
                onPress={() => share(r.id)}
                disabled={busy}
              />
              <Button title="✕" onPress={() => remove(r.id)} disabled={busy} />
            </>
          )}
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: 12, borderRadius: 8, backgroundColor: '#f2f2f2', gap: 6 },
  h2: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  h3: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  dim: { color: '#666' },
  rec: { color: '#c62828' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  grow: { flex: 1 },
});
