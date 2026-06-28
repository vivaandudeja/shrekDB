import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { TimeSeriesStore } from '../src/store.js';
import { ShrekReader } from '../src/reader.js';
import { ShrekFormatError } from '../src/format.js';
import type { Sample } from '../src/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shrekdb-ext-'));
  path = join(dir, 'series.shrekdb');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function series(from: number, n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ timestamp: from + i, value: i }));
}

describe('append', () => {
  it('extends an existing file and preserves order', async () => {
    await TimeSeriesStore.writeAll(path, series(1000, 5), { presorted: true });
    await TimeSeriesStore.append(path, series(1005, 5), { presorted: true });

    const reader = await ShrekReader.open(path);
    expect(reader.count).toBe(10);
    const all = await reader.readBlock(0, 10);
    expect(all.map((s) => s.timestamp)).toEqual([
      1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009,
    ]);
    await reader.close();
  });

  it('sorts an unsorted append batch before writing', async () => {
    await TimeSeriesStore.writeAll(path, series(0, 1), { presorted: true });
    await TimeSeriesStore.append(path, [
      { timestamp: 30, value: 3 },
      { timestamp: 10, value: 1 },
      { timestamp: 20, value: 2 },
    ]);
    const all = await new TimeSeriesStore(path).query();
    expect(all.map((s) => s.timestamp)).toEqual([0, 10, 20, 30]);
  });

  it('rejects a batch that predates the last stored timestamp', async () => {
    await TimeSeriesStore.writeAll(path, series(1000, 5), { presorted: true });
    await expect(
      TimeSeriesStore.append(path, [{ timestamp: 500, value: 9 }]),
    ).rejects.toThrow(ShrekFormatError);
  });

  it('rejects a non-finite timestamp', async () => {
    await TimeSeriesStore.writeAll(path, series(1000, 5), { presorted: true });
    await expect(
      TimeSeriesStore.append(path, [{ timestamp: Number.NaN, value: 9 }]),
    ).rejects.toThrow(ShrekFormatError);
  });
});

describe('stats & windowCount', () => {
  it('computes aggregates over the whole series', async () => {
    // values 0..99
    await TimeSeriesStore.writeAll(path, series(1000, 100), { presorted: true });
    const reader = await ShrekReader.open(path);
    const s = await reader.stats();
    expect(s).not.toBeNull();
    expect(s!.count).toBe(100);
    expect(s!.min).toBe(0);
    expect(s!.max).toBe(99);
    expect(s!.sum).toBe(4950);
    expect(s!.mean).toBeCloseTo(49.5);
    expect(s!.first.timestamp).toBe(1000);
    expect(s!.last.timestamp).toBe(1099);
    await reader.close();
  });

  it('respects the time window and counts it cheaply', async () => {
    await TimeSeriesStore.writeAll(path, series(1000, 100), { presorted: true });
    const reader = await ShrekReader.open(path);
    expect(await reader.windowCount({ from: 1010, to: 1019 })).toBe(10);
    const s = await reader.stats({ from: 1010, to: 1019 });
    expect(s!.count).toBe(10);
    expect(s!.min).toBe(10);
    expect(s!.max).toBe(19);
    await reader.close();
  });

  it('returns null for an empty window', async () => {
    await TimeSeriesStore.writeAll(path, series(1000, 10), { presorted: true });
    const reader = await ShrekReader.open(path);
    expect(await reader.stats({ from: 9000, to: 9999 })).toBeNull();
    expect(await reader.windowCount({ from: 9000, to: 9999 })).toBe(0);
    await reader.close();
  });

  it('never reports a negative count for an inverted window', async () => {
    await TimeSeriesStore.writeAll(path, [10, 20, 30].map((t) => ({ timestamp: t, value: t })), {
      presorted: true,
    });
    const reader = await ShrekReader.open(path);
    expect(await reader.windowCount({ from: 25, to: 15 })).toBe(0);
    await reader.close();
  });

  it('reports NaN min/max for an all-NaN-value window (no Infinity sentinels)', async () => {
    await TimeSeriesStore.writeAll(path, [
      { timestamp: 1, value: Number.NaN },
      { timestamp: 2, value: Number.NaN },
    ]);
    const reader = await ShrekReader.open(path);
    const s = await reader.stats();
    expect(s!.count).toBe(2);
    expect(Number.isNaN(s!.min)).toBe(true);
    expect(Number.isNaN(s!.max)).toBe(true);
    await reader.close();
  });
});
