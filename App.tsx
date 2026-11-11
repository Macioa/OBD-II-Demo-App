import React, { useEffect, useState } from 'react';
import {
  AppState,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { dlog } from './debugLog';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import CalibrateScreen from './src/screens/CalibrateScreen';
import ObdScreen from './src/screens/ObdScreen';
import TrackScreen from './src/screens/TrackScreen';

// Minimal tab shell; swap for @react-navigation once Track/Sessions/Maps land.
// Every screen stays mounted and inactive ones are only hidden: the OBD
// session and the sensor stream must survive switching tabs.
const TABS = [
  { key: 'track', label: 'Track', Screen: TrackScreen },
  { key: 'calibrate', label: 'Calibrate', Screen: CalibrateScreen },
  { key: 'obd', label: 'Vehicle (OBD)', Screen: ObdScreen },
] as const;

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('calibrate');
  // Backgrounding throttles sensors; log it so a recording shows why data thinned.
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => dlog(`app ${st}`));
    return () => sub.remove();
  }, []);
  useEffect(() => dlog(`tab ${tab}`), [tab]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={s.root}>
        {TABS.map(({ key, Screen }) => (
          <View key={key} style={[s.body, key !== tab && s.hidden]}>
            <Screen />
          </View>
        ))}
        <View style={s.bar}>
          {TABS.map(t => (
            <Pressable key={t.key} style={s.tab} onPress={() => setTab(t.key)}>
              <Text style={[s.label, t.key === tab && s.active]}>
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  // Explicit light theme: the screens use dark text, so don't inherit the
  // system dark window background.
  root: { flex: 1, backgroundColor: '#fff' },
  body: { flex: 1 },
  hidden: { display: 'none' },
  bar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#ddd' },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  label: { color: '#555' },
  active: { color: '#000', fontWeight: '700' },
});
