// Jest stand-in for react-native-ble-plx: the real package ships untranspiled
// ESM and needs the native BLE module. Jest picks this up automatically
// because __mocks__/ sits next to node_modules/.
export class BleManager {
  state = jest.fn().mockResolvedValue('PoweredOff');
  startDeviceScan = jest.fn();
  stopDeviceScan = jest.fn();
  connectToDevice = jest.fn();
  cancelDeviceConnection = jest.fn();
  destroy = jest.fn();
}

export const State = {
  Unknown: 'Unknown',
  Resetting: 'Resetting',
  Unsupported: 'Unsupported',
  Unauthorized: 'Unauthorized',
  PoweredOff: 'PoweredOff',
  PoweredOn: 'PoweredOn',
} as const;

export type Device = any;
export type Characteristic = any;
