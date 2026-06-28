import { parseCsv, type CsvParseOptions } from './csv.js';
import { ShrekFormatError } from './format.js';
import { ShrekReader } from './reader.js';
import { ShrekWriter } from './writer.js';
import type { QueryOptions, Sample } from './types.js';

/** Options for writing a series to disk. */
export interface WriteOptions {
  /** Sensor / telemetry category code (0–65535). Defaults to 0. */
  metricId?: number;
  /**
   * Assume the input is already sorted by ascending timestamp and skip the
   * sort. Defaults to false (the store sorts defensively).
   */
  presorted?: boolean;
}

/**
 * Ergonomic façade over {@link ShrekWriter} / {@link ShrekReader}, bound to a
 * single file path.
 *
 * Whole-series writes guarantee the ascending-timestamp invariant the reader
 * relies on; queries open a fresh reader, run, and clean up.
 */
export class TimeSeriesStore {
  constructor(readonly path: string) {}

  /** Write a complete series to `path`, sorting by timestamp unless `presorted`. */
  static async writeAll(
    path: string,
    samples: readonly Sample[],
    opts: WriteOptions = {},
  ): Promise<TimeSeriesStore> {
    // Validate before touching the filesystem: a non-finite timestamp would
    // poison the sort comparator (breaking the ascending invariant) and, left
    // to the encoder, would throw mid-write and leave a header-only file behind.
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i].timestamp)) {
        throw new ShrekFormatError(`sample[${i}].timestamp must be a finite number, got ${samples[i].timestamp}`);
      }
    }

    const ordered = opts.presorted
      ? samples
      : [...samples].sort((a, b) => a.timestamp - b.timestamp);

    const writer = await ShrekWriter.create(path, {
      metricId: opts.metricId,
      baseTimestamp: ordered[0]?.timestamp ?? Date.now(),
    });
    try {
      await writer.append(ordered);
    } finally {
      await writer.close();
    }
    return new TimeSeriesStore(path);
  }

  /** Parse a CSV string and write it to `path` as a `.shrekdb` file. */
  static async ingestCsv(
    path: string,
    csv: string,
    opts: CsvParseOptions & WriteOptions = {},
  ): Promise<TimeSeriesStore> {
    return TimeSeriesStore.writeAll(path, parseCsv(csv, opts), opts);
  }

  /**
   * Append samples to an existing file, preserving the ascending-timestamp
   * invariant. Validates finiteness up front and rejects any batch whose first
   * (sorted) sample predates the last record already on disk.
   */
  static async append(
    path: string,
    samples: readonly Sample[],
    opts: { presorted?: boolean } = {},
  ): Promise<TimeSeriesStore> {
    for (let i = 0; i < samples.length; i++) {
      if (!Number.isFinite(samples[i].timestamp)) {
        throw new ShrekFormatError(`sample[${i}].timestamp must be a finite number, got ${samples[i].timestamp}`);
      }
    }
    const ordered = opts.presorted
      ? samples
      : [...samples].sort((a, b) => a.timestamp - b.timestamp);
    if (ordered.length === 0) return new TimeSeriesStore(path);

    // Guard the ascending invariant against the existing tail.
    const reader = await ShrekReader.open(path);
    let lastTs: number;
    try {
      lastTs =
        reader.count > 0
          ? (await reader.readRecord(reader.count - 1)).timestamp
          : Number.NEGATIVE_INFINITY;
    } finally {
      await reader.close();
    }
    if (ordered[0].timestamp < lastTs) {
      throw new ShrekFormatError(
        `cannot append: first new timestamp ${ordered[0].timestamp} predates last stored timestamp ${lastTs}`,
      );
    }

    const writer = await ShrekWriter.open(path);
    try {
      await writer.append(ordered);
    } finally {
      await writer.close();
    }
    return new TimeSeriesStore(path);
  }

  /** Open a low-level reader for this store. Caller is responsible for closing it. */
  open(): Promise<ShrekReader> {
    return ShrekReader.open(this.path);
  }

  /** Run a windowed (optionally downsampled) query, managing the reader lifecycle. */
  async query(opts: QueryOptions = {}): Promise<Sample[]> {
    const reader = await this.open();
    try {
      return await reader.query(opts);
    } finally {
      await reader.close();
    }
  }
}
