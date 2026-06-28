/**
 * A single time-series data point.
 *
 * `timestamp` is epoch milliseconds and `value` is an IEEE-754 double. These map
 * directly onto a 16-byte on-disk record (8B timestamp + 8B value).
 */
export interface Sample {
  /** Epoch milliseconds. Stored on disk as a signed 64-bit integer. */
  timestamp: number;
  /** Metric value. Stored on disk as a 64-bit double. */
  value: number;
}

/** Decoded contents of a `.shrekdb` file's 16-byte metadata header. */
export interface ShrekHeader {
  /** Format version. Lets the layout evolve without breaking old files. */
  version: number;
  /** Short code identifying the sensor / telemetry category (0–65535). */
  metricId: number;
  /** Epoch milliseconds marking when recording started. */
  baseTimestamp: number;
}

/** Options for a windowed, optionally-downsampled query. */
export interface QueryOptions {
  /** Inclusive lower bound (epoch ms). Defaults to the start of the series. */
  from?: number;
  /** Inclusive upper bound (epoch ms). Defaults to the end of the series. */
  to?: number;
  /**
   * Target number of points to return. When the window holds more than this,
   * the result is downsampled with LTTB to preserve visual shape. Omit to
   * return every point in the window.
   */
  maxPoints?: number;
}

/** Aggregate statistics over a time window. */
export interface Stats {
  /** Number of records in the window. */
  count: number;
  /** Smallest value. */
  min: number;
  /** Largest value. */
  max: number;
  /** Arithmetic mean of the values. */
  mean: number;
  /** Sum of the values. */
  sum: number;
  /** First record in the window (by time). */
  first: Sample;
  /** Last record in the window (by time). */
  last: Sample;
}
