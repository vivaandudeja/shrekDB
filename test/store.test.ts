import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { TimeSeriesStore } from '../src/store.js';
import { ShrekFormatError } from '../src/format.js';
import type { Sample } from '../src/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shrekdb-test-'));
  path = join(dir, 'series.shrekdb');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function series(n: number): Sample[] {
  return Array.from({ length: n }, (_, i) => ({ timestamp: 1000 + i, value: i * 2 }));
}

describe('TimeSeriesStore', () => {
  it('writes and reads back every sample', async () => {
    const data = series(2000);
    const store = await TimeSeriesStore.writeAll(path, data, { metricId: 9 });

    const reader = await store.open();
    expect(reader.count).toBe(2000);
    expect(reader.header.metricId).toBe(9);
    expect(await reader.readRecord(0)).toEqual(data[0]);
    expect(await reader.readRecord(1999)).toEqual(data[1999]);
    await reader.close();
  });

  it('handles an empty series', async () => {
    const store = await TimeSeriesStore.writeAll(path, []);
    const reader = await store.open();
    expect(reader.count).toBe(0);
    expect(await reader.query()).toEqual([]);
    await reader.close();
  });

  it('sorts unsorted input on write', async () => {
    const store = await TimeSeriesStore.writeAll(path, [
      { timestamp: 30, value: 3 },
      { timestamp: 10, value: 1 },
      { timestamp: 20, value: 2 },
    ]);
    const all = await store.query();
    expect(all.map((s) => s.timestamp)).toEqual([10, 20, 30]);
  });

  it('returns only the requested time window (inclusive bounds)', async () => {
    const store = await TimeSeriesStore.writeAll(path, series(1000), { presorted: true });
    const window = await store.query({ from: 1100, to: 1199 });
    expect(window).toHaveLength(100);
    expect(window[0].timestamp).toBe(1100);
    expect(window.at(-1)?.timestamp).toBe(1199);
  });

  it('handles windows with no matching records', async () => {
    const store = await TimeSeriesStore.writeAll(path, series(100), { presorted: true });
    expect(await store.query({ from: 5000, to: 6000 })).toEqual([]);
  });

  it('clamps out-of-range window bounds to the series', async () => {
    const store = await TimeSeriesStore.writeAll(path, series(100), { presorted: true });
    const all = await store.query({ from: -1e9, to: 1e9 });
    expect(all).toHaveLength(100);
  });

  it('downsamples a window when maxPoints is set', async () => {
    const store = await TimeSeriesStore.writeAll(path, series(50_000), { presorted: true });
    const points = await store.query({ maxPoints: 1000 });
    expect(points).toHaveLength(1000);
    expect(points[0].timestamp).toBe(1000);
    expect(points.at(-1)?.timestamp).toBe(1000 + 49_999);
  });

  it('ingests CSV, skipping the header row', async () => {
    const csv = ['timestamp,value', '1000,1.5', '1001,2.5', '', '1002,3.5'].join('\n');
    const store = await TimeSeriesStore.ingestCsv(path, csv);
    const all = await store.query();
    expect(all).toEqual([
      { timestamp: 1000, value: 1.5 },
      { timestamp: 1001, value: 2.5 },
      { timestamp: 1002, value: 3.5 },
    ]);
  });

  it('skips rows with empty or missing cells', async () => {
    const csv = ['1000,1.5', '1001,', ',2.5', '1002,3.5'].join('\n');
    const store = await TimeSeriesStore.ingestCsv(path, csv);
    const all = await store.query();
    expect(all).toEqual([
      { timestamp: 1000, value: 1.5 },
      { timestamp: 1002, value: 3.5 },
    ]);
  });

  it('rejects a non-finite timestamp and leaves no orphan file', async () => {
    const { access } = await import('node:fs/promises');
    await expect(
      TimeSeriesStore.writeAll(path, [
        { timestamp: 50, value: 5 },
        { timestamp: Number.NaN, value: 9 },
        { timestamp: 10, value: 1 },
      ]),
    ).rejects.toThrow(ShrekFormatError);
    // Validation happens before the file is created, so nothing is left behind.
    await expect(access(path)).rejects.toThrow();
  });

  it('rejects opening a non-shrekdb file', async () => {
    const bogus = join(dir, 'bogus.shrekdb');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(bogus, Buffer.from('not a shrekdb file at all'));
    await expect(new TimeSeriesStore(bogus).open()).rejects.toThrow(ShrekFormatError);
  });
});
