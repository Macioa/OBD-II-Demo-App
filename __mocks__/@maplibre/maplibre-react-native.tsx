// Jest stand-in for MapLibre: the real package needs its native views.
import React from 'react';
import { View } from 'react-native';

const Pass = ({ children }: { children?: React.ReactNode }) => (
  <View>{children}</View>
);
export const Map = Pass;
export const Camera = Pass;
export const GeoJSONSource = Pass;
export const Layer = Pass;
export const OfflineManager = {
  setMaximumAmbientCacheSize: jest.fn().mockResolvedValue(undefined),
  createPack: jest.fn().mockResolvedValue({ id: 'p' }),
};
