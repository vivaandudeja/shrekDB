import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { ShrekWriter } from '../src/writer.js';
import { ShrekReader } from '../src/reader.js';
import type { Sample } from '../src/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shrekdb-reader-'));
  path = join(dir, 'series.shrekdb');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(samples: Sample[]): Promise<void> {
  const w = await ShrekWriter.create(path, { metricId: 1 });
  await w.append(samples);
  await w.close();
}

describe('ShrekReader', () => {
  it('round-trips many records across multiple appends', async () => {
    const w = await ShrekWriter.create(path, { metricId: 2 });
    await w.append([{ timestamp: 1, value: 1 }]);
    await w.append([
      { timestamp: 2, value: 2 },
      { timestamp: 3, value: 3 },
    ]);
    expect(w.length).toBe(3);
    await w.close();

    const r = await ShrekReader.open(path);
    expect(r.count).toBe(3);
    expect(await r.readBlock(0, 3)).toEqual([
      { timestamp: 1, value: 1 },
      { timestamp: 2, value: 2 },
      { timestamp: 3, value: 3 },
    ]);
    await r.close();
  });

  it('throws on out-of-range and non-integer indices', async () => {
    await write([{ timestamp: 1, value: 1 }]);
    const r = await ShrekReader.open(path);
    await expect(r.readRecord(-1)).rejects.toThrow(RangeError);
    await expect(r.readRecord(1)).rejects.toThrow(RangeError);
    await expect(r.readRecord(0.5)).rejects.toThrow(RangeError);
    await r.close();
  });

  it('finds exact window bounds via binary search', async () => {
    // Timestamps with gaps, so from/to may not land on an exact record.
    const samples = [10, 20, 30, 40, 50].map((t) => ({ timestamp: t, value: t }));
    await write(samples);
    const r = await ShrekReader.open(path);

    expect((await r.query({ from: 25, to: 45 })).map((s) => s.timestamp)).toEqual([30, 40]);
    expect((await r.query({ from: 20, to: 40 })).map((s) => s.timestamp)).toEqual([20, 30, 40]);
    expect((await r.query({ from: 50, to: 50 })).map((s) => s.timestamp)).toEqual([50]);
    expect(await r.query({ from: 51 })).toEqual([]);
    expect(await r.query({ to: 9 })).toEqual([]);
    await r.close();
  });

  it('readBlock clamps ranges to the file', async () => {
    await write([10, 20, 30].map((t) => ({ timestamp: t, value: t })));
    const r = await ShrekReader.open(path);
    expect(await r.readBlock(-5, 99)).toHaveLength(3);
    expect(await r.readBlock(2, 1)).toEqual([]);
    await r.close();
  });

  it('throws instead of returning garbage when the file is truncated after open', async () => {
    await write([10, 20, 30, 40].map((t) => ({ timestamp: t, value: t })));
    const r = await ShrekReader.open(path);
    expect(r.count).toBe(4);
    const { truncate } = await import('node:fs/promises');
    await truncate(path, 16 + 16); // header + 1 record only
    await expect(r.readRecord(3)).rejects.toThrow(/truncated|short read/i);
    await expect(r.readBlock(0, 4)).rejects.toThrow(/truncated|short read/i);
    await r.close();
  });

  it('rejects NaN query bounds', async () => {
    await write([{ timestamp: 1, value: 1 }]);
    const r = await ShrekReader.open(path);
    await expect(r.query({ from: Number.NaN })).rejects.toThrow(RangeError);
    await expect(r.query({ to: Number.NaN })).rejects.toThrow(RangeError);
    await r.close();
  });
});
