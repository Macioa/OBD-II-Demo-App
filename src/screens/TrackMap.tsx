import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  OfflineManager,
} from '@maplibre/maplibre-react-native';
import { dlog } from '../../debugLog';
import { EN } from '../geo/enu';
import { Origin, boundsOf, toGeoJson } from '../geo/overlay';

/** OpenStreetMap-derived vector tiles (OpenFreeMap), no API key. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const OFFLINE_ZOOM = { min: 12, max: 17 };
const OFFLINE_PAD_M = 1500;

// Viewed tiles are kept for airplane mode even without a saved pack.
OfflineManager.setMaximumAmbientCacheSize(200 * 1024 * 1024).catch(e =>
  dlog(`map: ambient cache size failed ${e}`),
);

type Props = {
  origin: Origin;
  est: EN[];
  gps: EN[];
  links: { a: EN; b: EN }[];
  cur: EN;
  showGps: boolean;
};

/** M3: estimate + GPS paths and per-second error connectors on a map. */
export default function TrackMap({
  origin,
  est,
  gps,
  links,
  cur,
  showGps,
}: Props) {
  const [follow, setFollow] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);

  const geo = useMemo(
    () => toGeoJson(origin, est, showGps ? gps : [], showGps ? links : []),
    [origin, est, gps, links, showGps],
  );
  const curPt: GeoJSON.Feature<GeoJSON.Point> = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Point',
      coordinates: toGeoJson(origin, [cur], [], []).est.geometry.coordinates[0],
    },
  };
  const fit = boundsOf(origin, showGps ? [...est, ...gps] : est, 20);

  async function saveOffline() {
    const bounds = boundsOf(origin, [...est, ...gps], OFFLINE_PAD_M);
    const name = `track-${new Date().toISOString()}`;
    setOffline('starting…');
    dlog(`map: offline pack ${name} bounds=${bounds.map(x => x.toFixed(4))}`);
    try {
      await OfflineManager.createPack(
        {
          mapStyle: MAP_STYLE,
          bounds,
          minZoom: OFFLINE_ZOOM.min,
          maxZoom: OFFLINE_ZOOM.max,
          metadata: { name },
        },
        (_pack, st) => {
          const pct = Math.round(st.percentage ?? 0);
          setOffline(pct >= 100 ? 'saved ✓' : `${pct}%`);
          if (pct >= 100) {
            dlog(`map: offline pack done ${name}`);
          }
        },
        (_pack, err) => {
          setOffline('failed');
          dlog(`map: offline pack error ${err.message}`);
        },
      );
    } catch (e) {
      setOffline('failed');
      dlog(`map: offline pack threw ${e}`);
    }
  }

  return (
    <View style={s.wrap}>
      <Map
        style={s.map}
        mapStyle={MAP_STYLE}
        attribution
        logo={false}
        onRegionDidChange={e => {
          if (e.nativeEvent.userInteraction) {
            setFollow(false);
          }
        }}
        onDidFailLoadingMap={() => {
          setFailed(true);
          dlog('map: style failed to load (offline, nothing cached?)');
        }}
        onDidFinishLoadingMap={() => setFailed(false)}
      >
        {follow ? (
          <Camera bounds={fit} padding={PAD} duration={300} />
        ) : (
          <Camera />
        )}
        <GeoJSONSource id="links" data={geo.links}>
          <Layer
            type="line"
            id="links-line"
            paint={{
              'line-color': '#888',
              'line-width': 1,
              'line-dasharray': [1, 2],
            }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="gps" data={geo.gps}>
          <Layer
            type="line"
            id="gps-line"
            paint={{ 'line-color': '#1565c0', 'line-width': 4 }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="est" data={geo.est}>
          <Layer
            type="line"
            id="est-line"
            paint={{
              'line-color': '#d84315',
              'line-width': 3,
              'line-dasharray': [2, 1],
            }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="cur" data={curPt}>
          <Layer
            type="circle"
            id="cur-dot"
            paint={{
              'circle-radius': 6,
              'circle-color': '#fff',
              'circle-stroke-color': '#d84315',
              'circle-stroke-width': 3,
            }}
          />
        </GeoJSONSource>
      </Map>
      {failed && (
        <Text style={s.banner}>
          Map tiles unavailable offline here — use Grid, or save the area while
          online.
        </Text>
      )}
      <View style={s.btns}>
        {!follow && (
          <Pressable style={s.btn} onPress={() => setFollow(true)}>
            <Text>⌖ Fit</Text>
          </Pressable>
        )}
        <Pressable
          style={s.btn}
          onPress={saveOffline}
          disabled={offline != null && /%|starting/.test(offline)}
        >
          <Text>⤓ Offline {offline ?? ''}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const PAD = { top: 40, bottom: 40, left: 40, right: 40 };

const s = StyleSheet.create({
  wrap: { flex: 1, borderRadius: 8, overflow: 'hidden' },
  map: { flex: 1 },
  banner: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#fff3e0',
    color: '#e65100',
    fontSize: 12,
  },
  btns: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    flexDirection: 'row',
    gap: 8,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
});
