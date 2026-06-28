import { open, type FileHandle } from 'node:fs/promises';
import {
  decodeHeader,
  encodeHeader,
  encodeRecord,
  FORMAT_VERSION,
  HEADER_SIZE,
  RECORD_SIZE,
} from './format.js';
import type { ShrekHeader, Sample } from './types.js';

/** Options for creating a new `.shrekdb` file. */
export interface WriterOptions {
  /** Sensor / telemetry category code (0–65535). Defaults to 0. */
  metricId?: number;
  /** Recording start time (epoch ms). Defaults to "now". */
  baseTimestamp?: number;
}

/**
 * Append-only writer for `.shrekdb` files.
 *
 * Writes the header on {@link ShrekWriter.create}, then streams fixed-size
 * records. Records are expected in ascending-timestamp order so that the reader
 * can binary-search by time.
 */
export class ShrekWriter {
  private count = 0;

  private constructor(
    private readonly fh: FileHandle,
    /** The header that was written to disk. */
    readonly header: ShrekHeader,
  ) {}

  /** Create (or truncate) a file and write its header. */
  static async create(path: string, opts: WriterOptions = {}): Promise<ShrekWriter> {
    const header: ShrekHeader = {
      version: FORMAT_VERSION,
      metricId: opts.metricId ?? 0,
      baseTimestamp: opts.baseTimestamp ?? Date.now(),
    };
    const fh = await open(path, 'w');
    try {
      await fh.write(encodeHeader(header), 0, HEADER_SIZE, 0);
    } catch (err) {
      await fh.close();
      throw err;
    }
    return new ShrekWriter(fh, header);
  }

  /**
   * Open an existing file for appending: reads + validates its header and seeks
   * past the last record so subsequent {@link ShrekWriter.append} calls extend
   * the series rather than overwriting it.
   */
  static async open(path: string): Promise<ShrekWriter> {
    const fh = await open(path, 'r+');
    try {
      const headerBuf = Buffer.alloc(HEADER_SIZE);
      const { bytesRead } = await fh.read(headerBuf, 0, HEADER_SIZE, 0);
      const header = decodeHeader(headerBuf.subarray(0, bytesRead));
      const { size } = await fh.stat();
      const writer = new ShrekWriter(fh, header);
      writer.count = Math.max(0, Math.floor((size - HEADER_SIZE) / RECORD_SIZE));
      return writer;
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  /** Number of records written so far. */
  get length(): number {
    return this.count;
  }

  /** Append a batch of samples. Encodes the whole batch in one buffer, one write. */
  async append(samples: readonly Sample[]): Promise<void> {
    if (samples.length === 0) return;
    const buf = Buffer.allocUnsafe(samples.length * RECORD_SIZE);
    for (let i = 0; i < samples.length; i++) {
      encodeRecord(buf, i * RECORD_SIZE, samples[i].timestamp, samples[i].value);
    }
    const pos = HEADER_SIZE + this.count * RECORD_SIZE;
    await this.fh.write(buf, 0, buf.length, pos);
    this.count += samples.length;
  }

  /** Flush and close the underlying file handle. */
  async close(): Promise<void> {
    await this.fh.close();
  }
}
