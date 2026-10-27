import type { MetricSample } from "./metric-history";

const POINTS = 24;
export const previewCurve = Array.from({ length: POINTS }, (_, i) => 23 - 12 * Math.sin((i / (POINTS - 1)) * Math.PI * 2 - 1));

export function metricCurve(samples: MetricSample[], key: keyof MetricSample): number[] | null {
  const valid: Array<{ time: number; value: number }> = [];
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      valid.length = 0;
    } else {
      valid.push({ time: sample.time, value });
    }
  }
  if (valid.length < 2 || valid[valid.length - 1].time <= valid[0].time) return null;
  const values = valid.map((sample) => sample.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return Array.from({ length: POINTS }, (_, i) => {
    const time = valid[0].time + (valid[valid.length - 1].time - valid[0].time) * i / (POINTS - 1);
    const next = valid.findIndex((sample) => sample.time >= time);
    const right = valid[Math.max(0, next)];
    const left = valid[Math.max(0, next - 1)];
    const fraction = right.time === left.time ? 0 : (time - left.time) / (right.time - left.time);
    const value = left.value + (right.value - left.value) * fraction;
    return max === min ? 21 : 39 - (value - min) / (max - min) * 36;
  });
}

export function blendCurves(from: number[], to: number[], amount: number): number[] {
  return from.map((value, index) => value + (to[index] - value) * amount);
}
