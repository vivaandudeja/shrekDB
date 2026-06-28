import { open, type FileHandle } from 'node:fs/promises';
import { decodeHeader, HEADER_SIZE, RECORD_SIZE, recordOffset } from './format.js';
import { lttb } from './lttb.js';
import type { ShrekHeader, QueryOptions, Sample, Stats } from './types.js';

/**
 * Random-access reader for `.shrekdb` files.
 *
 * Node has no portable `mmap`, so we lean on positional `FileHandle.read`: the
 * OS page cache serves repeated reads from memory, and we only ever ask for the
 * exact byte ranges we need — the same "touch only the target bytes" property
 * the spec calls for. Time-window queries binary-search the (sorted) records,
 * then read the matching block in a single I/O.
 */
export class ShrekReader {
  private constructor(
    private readonly fh: FileHandle,
    /** Decoded file header. */
    readonly header: ShrekHeader,
    /** Total number of records in the file. */
    readonly count: number,
  ) {}

  /** Open a file, read + validate its header, and compute the record count. */
  static async open(path: string): Promise<ShrekReader> {
    const fh = await open(path, 'r');
    try {
      const headerBuf = Buffer.alloc(HEADER_SIZE);
      const { bytesRead } = await fh.read(headerBuf, 0, HEADER_SIZE, 0);
      const header = decodeHeader(headerBuf.subarray(0, bytesRead));
      const { size } = await fh.stat();
      const count = Math.max(0, Math.floor((size - HEADER_SIZE) / RECORD_SIZE));
      return new ShrekReader(fh, header, count);
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  /** Read a single record by index. O(1) — one positional read at a computed offset. */
  async readRecord(index: number): Promise<Sample> {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(`Record index ${index} out of range [0, ${this.count})`);
    }
    const buf = Buffer.allocUnsafe(RECORD_SIZE);
    const { bytesRead } = await this.fh.read(buf, 0, RECORD_SIZE, recordOffset(index));
    if (bytesRead < RECORD_SIZE) {
      throw new Error(`Short read at record ${index}: file was truncated after open (got ${bytesRead}/${RECORD_SIZE} bytes)`);
    }
    return { timestamp: Number(buf.readBigInt64LE(0)), value: buf.readDoubleLE(8) };
  }

  /** Read a contiguous run of records `[start, end)` in one I/O. */
  async readBlock(start: number, end: number): Promise<Sample[]> {
    const lo = Math.max(0, Math.floor(start));
    const hi = Math.min(this.count, Math.floor(end));
    if (hi <= lo) return [];

    const n = hi - lo;
    const buf = Buffer.allocUnsafe(n * RECORD_SIZE);
    const { bytesRead } = await this.fh.read(buf, 0, buf.length, recordOffset(lo));
    if (bytesRead < buf.length) {
      throw new Error(`Short read of records [${lo}, ${hi}): file was truncated after open (got ${bytesRead}/${buf.length} bytes)`);
    }

    const out: Sample[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * RECORD_SIZE;
      out[i] = { timestamp: Number(buf.readBigInt64LE(o)), value: buf.readDoubleLE(o + 8) };
    }
    return out;
  }

  /**
   * Windowed query with optional LTTB downsampling.
   *
   * Binary-searches the start/end indices for the `[from, to]` window, reads
   * that block, and — if it exceeds `maxPoints` — downsamples it for display.
   */
  async query(opts: QueryOptions = {}): Promise<Sample[]> {
    const [startIdx, endIdx] = await this.resolveWindow(opts.from, opts.to);
    const block = await this.readBlock(startIdx, endIdx);
    if (opts.maxPoints !== undefined && block.length > opts.maxPoints) {
      return lttb(block, opts.maxPoints);
    }
    return block;
  }

  /** Number of records that fall inside `[from, to]` — O(log n), no record read. */
  async windowCount(opts: { from?: number; to?: number } = {}): Promise<number> {
    const [startIdx, endIdx] = await this.resolveWindow(opts.from, opts.to);
    return Math.max(0, endIdx - startIdx); // inverted window (from > to) ⇒ 0, not negative
  }

  /**
   * Aggregate statistics over a time window. Streams the matching records in
   * chunks so a million-row window never materialises a million objects at
   * once. Returns `null` when the window is empty.
   */
  async stats(opts: { from?: number; to?: number } = {}): Promise<Stats | null> {
    const [startIdx, endIdx] = await this.resolveWindow(opts.from, opts.to);
    if (endIdx <= startIdx) return null;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let count = 0;
    let sawFinite = false;
    let first: Sample | undefined;
    let last: Sample | undefined;

    const CHUNK = 65_536;
    for (let i = startIdx; i < endIdx; i += CHUNK) {
      const block = await this.readBlock(i, Math.min(i + CHUNK, endIdx));
      for (const s of block) {
        // Only finite values feed min/max, so a NaN/Infinity value can't leave
        // the ±Infinity sentinels (or a phantom) in the result.
        if (Number.isFinite(s.value)) {
          if (s.value < min) min = s.value;
          if (s.value > max) max = s.value;
          sawFinite = true;
        }
        sum += s.value; // sum/mean propagate NaN honestly if any value is NaN
        count++;
        first ??= s;
        last = s;
      }
    }

    // first/last are set because endIdx > startIdx guarantees ≥ 1 record.
    return {
      count,
      min: sawFinite ? min : Number.NaN,
      max: sawFinite ? max : Number.NaN,
      mean: sum / count,
      sum,
      first: first!,
      last: last!,
    };
  }

  /** Resolve a `[from, to]` window to half-open record indices `[start, end)`. */
  private async resolveWindow(from?: number, to?: number): Promise<[number, number]> {
    if (from !== undefined && Number.isNaN(from)) {
      throw new RangeError('query "from" bound must not be NaN');
    }
    if (to !== undefined && Number.isNaN(to)) {
      throw new RangeError('query "to" bound must not be NaN');
    }
    const lo = from ?? Number.NEGATIVE_INFINITY;
    const hi = to ?? Number.POSITIVE_INFINITY;
    const startIdx = Number.isFinite(lo) ? await this.lowerBound(lo) : 0;
    const endIdx = Number.isFinite(hi) ? await this.upperBound(hi) : this.count;
    return [startIdx, endIdx];
  }

  /** Index of the first record whose timestamp is ≥ `target` (assumes sorted). */
  private async lowerBound(target: number): Promise<number> {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const { timestamp } = await this.readRecord(mid);
      if (timestamp < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the first record whose timestamp is > `target` (assumes sorted). */
  private async upperBound(target: number): Promise<number> {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const { timestamp } = await this.readRecord(mid);
      if (timestamp <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Close the underlying file handle. */
  async close(): Promise<void> {
    await this.fh.close();
  }
}
