import {BiasEstimator, compassPoint, headingFromQuat} from '../src/sensors/imu';

// Quaternion for a rotation of `deg` about world Z (up), counter-clockwise.
const yaw = (deg: number) => {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)] as const;
};

test('flat phone pointing north reads 0°', () => {
  expect(headingFromQuat(...yaw(0))).toBeCloseTo(0);
});

test('CCW yaw of 90° points the phone west (270°)', () => {
  expect(headingFromQuat(...yaw(90))).toBeCloseTo(270);
  expect(headingFromQuat(...yaw(-90))).toBeCloseTo(90);
});

test('compass points', () => {
  expect(compassPoint(0)).toBe('N');
  expect(compassPoint(87)).toBe('E');
  expect(compassPoint(350)).toBe('N');
});

test('bias estimator averages stride-4 samples', () => {
  const b = new BiasEstimator();
  b.add([0, 1, 2, 3, 0.01, 3, 4, 5]);
  expect(b.mean()).toEqual([2, 3, 4]);
});
