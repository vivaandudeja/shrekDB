import { describe, it, expect } from 'vitest';
import { lttb } from '../src/lttb.js';
import type { Sample } from '../src/types.js';

function ramp(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ timestamp: i, value: Math.sin(i / 7) }));
}

describe('lttb', () => {
  it('returns a copy when the threshold is not smaller than the input', () => {
    const data = ramp(5);
    expect(lttb(data, 5)).toEqual(data);
    expect(lttb(data, 10)).toEqual(data);
  });

  it('honors degenerate thresholds without over-returning', () => {
    const data = ramp(5);
    expect(lttb(data, 2)).toEqual([data[0], data[4]]); // endpoints only
    expect(lttb(data, 1)).toEqual([data[0]]);
    expect(lttb(data, 0)).toEqual([]);
  });

  it('downsamples to exactly the threshold', () => {
    const data = ramp(10_000);
    const out = lttb(data, 500);
    expect(out).toHaveLength(500);
  });

  it('always keeps the first and last points', () => {
    const data = ramp(1000);
    const out = lttb(data, 50);
    expect(out[0]).toEqual(data[0]);
    expect(out.at(-1)).toEqual(data.at(-1));
  });

  it('preserves a sharp spike', () => {
    const data = ramp(2000);
    data[937] = { timestamp: 937, value: 9999 };
    const out = lttb(data, 200);
    expect(out.some((p) => p.value === 9999)).toBe(true);
  });

  it('keeps timestamps monotonically increasing', () => {
    const out = lttb(ramp(5000), 321);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].timestamp).toBeGreaterThan(out[i - 1].timestamp);
    }
  });

  it('floors a non-integer threshold instead of crashing', () => {
    // Fractional thresholds previously overran the array and threw a TypeError.
    for (const t of [5.5, 6.5, 7.5, 8.5, 10.5, 20.5]) {
      const out = lttb(ramp(100), t);
      expect(out).toHaveLength(Math.floor(t));
      expect(out[0]).toEqual({ timestamp: 0, value: Math.sin(0) });
      expect(out.at(-1)).toEqual({ timestamp: 99, value: Math.sin(99 / 7) });
    }
  });
});
