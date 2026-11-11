import React from 'react';
import {
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { saveDebugLog, shareDebugLog, dlogError } from '../../debugLog';
import { ObdStatus, startObd, stopObd, useObd } from '../obd/session';

/** Button look per session state (R2 in docs/plans/m3-revision.md). */
export const OBD_LOOK: Record<ObdStatus, { color: string; fg: string }> = {
  idle: { color: '#2196f3', fg: '#fff' },
  connecting: { color: '#f9a825', fg: '#000' },
  reconnecting: { color: '#f9a825', fg: '#000' },
  reading: { color: '#2e7d32', fg: '#fff' },
  error: { color: '#c62828', fg: '#fff' },
};

/** Display only: the OBD session itself lives in src/obd/session.ts. */
export default function ObdScreen() {
  const st = useObd();
  const look = OBD_LOOK[st.status];
  const active = st.status !== 'idle' && st.status !== 'error';

  const title =
    st.status === 'reading'
      ? `● Reading — cycle ${st.live.cycles ?? 0}`
      : st.status === 'connecting'
      ? `Connecting… ${st.step}`
      : st.status === 'reconnecting'
      ? st.step || 'Reconnecting…'
      : st.status === 'error'
      ? 'Reconnect'
      : 'Connect & Read';

  return (
    <View style={s.page}>
      <Pressable
        testID="obd-main"
        style={[s.main, { backgroundColor: look.color }]}
        onPress={active ? undefined : startObd}
        disabled={active}
      >
        <Text style={[s.mainTxt, { color: look.fg }]}>{title}</Text>
      </Pressable>

      {active && (
        <Pressable testID="obd-stop" style={s.stop} onPress={stopObd}>
          <Text style={s.stopTxt}>
            {st.status === 'reading' ? '■ Stop' : 'Cancel'}
          </Text>
        </Pressable>
      )}

      {st.message && !active && (
        <Text style={[s.msg, st.status === 'error' && s.err]}>
          {st.message}
        </Text>
      )}

      {(st.status === 'reading' || st.status === 'reconnecting') && (
        <Text style={s.live}>
          RPM {st.live.rpm ?? '-'} | {st.live.kmh ?? '-'} km/h | coolant{' '}
          {st.live.coolant ?? '-'} °C
        </Text>
      )}

      <View style={s.row}>
        <View style={s.grow}>
          <Button
            title="Save debug log"
            onPress={() => saveDebugLog().catch(e => dlogError('save', e))}
            disabled={active}
            color={st.failed ? '#c62828' : undefined}
          />
        </View>
        <View style={s.grow}>
          <Button
            title="Email debug log"
            onPress={() => shareDebugLog().catch(e => dlogError('share', e))}
            disabled={active}
            color={st.failed ? '#c62828' : undefined}
          />
        </View>
      </View>
      <ScrollView style={s.logBox}>
        <Text style={s.mono}>{st.log.join('\n')}</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 8 },
  main: { paddingVertical: 14, borderRadius: 6, alignItems: 'center' },
  mainTxt: { fontSize: 16, fontWeight: '700' },
  stop: {
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#c62828',
  },
  stopTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  msg: { color: '#444' },
  err: { color: '#c62828' },
  live: { fontSize: 18 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  logBox: { marginTop: 8 },
  mono: { fontFamily: 'monospace' },
});
