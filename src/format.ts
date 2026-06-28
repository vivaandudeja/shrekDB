import type { ShrekHeader } from './types.js';

/**
 * Low-level codec for the `.shrekdb` binary file format.
 *
 * Layout (little-endian throughout):
 *
 * ```
 * ┌──────────────── HEADER (16 bytes) ─────────────────┐
 * │ magic "SHRK" 4B │ version 2B │ metricId 2B │ base 8B │
 * ├──────────────── RECORDS (16 bytes each) ───────────┤
 * │ timestamp 8B (int64) │ value 8B (float64)           │  × N
 * └────────────────────────────────────────────────────┘
 * ```
 *
 * Every record is a fixed 16 bytes, so the byte offset of record `i` is a pure
 * arithmetic computation — no scanning required (O(1) random access):
 *
 *     offset = HEADER_SIZE + i * RECORD_SIZE
 */

/** ASCII magic string identifying a `.shrekdb` file. */
export const MAGIC = 'SHRK';
const MAGIC_BYTES = Buffer.from(MAGIC, 'ascii');

/** Current on-disk layout version written by this library. */
export const FORMAT_VERSION = 1;

/** Fixed size of the metadata header, in bytes. */
export const HEADER_SIZE = 16;

/** Fixed size of a single data record, in bytes. */
export const RECORD_SIZE = 16;

/** Thrown when a buffer does not conform to the `.shrekdb` format. */
export class ShrekFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShrekFormatError';
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Convert an epoch-ms `number` to a signed 64-bit `bigint`, rejecting values
 * that can't be stored — `NaN`/`Infinity` (which would make `BigInt()` throw an
 * opaque error) and anything outside the int64 range. Surfaced as a
 * {@link ShrekFormatError} so callers see a clear, typed failure.
 */
function toInt64(value: number, field: string): bigint {
  if (!Number.isFinite(value)) {
    throw new ShrekFormatError(`${field} must be a finite number, got ${value}`);
  }
  const big = BigInt(Math.trunc(value));
  if (big < INT64_MIN || big > INT64_MAX) {
    throw new ShrekFormatError(`${field} is outside the int64 range: ${value}`);
  }
  return big;
}

/** Serialize a header into a fresh {@link HEADER_SIZE}-byte buffer. */
export function encodeHeader(header: ShrekHeader): Buffer {
  if (!Number.isInteger(header.metricId) || header.metricId < 0 || header.metricId > 0xffff) {
    throw new ShrekFormatError(`metricId must be an integer 0–65535: ${header.metricId}`);
  }
  if (!Number.isInteger(header.version) || header.version < 0 || header.version > 0xffff) {
    throw new ShrekFormatError(`version must be an integer 0–65535: ${header.version}`);
  }
  const buf = Buffer.alloc(HEADER_SIZE);
  MAGIC_BYTES.copy(buf, 0); //                            bytes 0..4
  buf.writeUInt16LE(header.version, 4); //                bytes 4..6
  buf.writeUInt16LE(header.metricId, 6); //               bytes 6..8
  buf.writeBigInt64LE(toInt64(header.baseTimestamp, 'baseTimestamp'), 8); // bytes 8..16
  return buf;
}

/** Parse and validate a header from the first {@link HEADER_SIZE} bytes of a file. */
export function decodeHeader(buf: Buffer): ShrekHeader {
  if (buf.length < HEADER_SIZE) {
    throw new ShrekFormatError(`Header too small: got ${buf.length} bytes, need ${HEADER_SIZE}`);
  }
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) {
    throw new ShrekFormatError(`Bad magic bytes: expected "${MAGIC}", got "${magic}"`);
  }
  const version = buf.readUInt16LE(4);
  if (version !== FORMAT_VERSION) {
    throw new ShrekFormatError(`Unsupported format version: ${version} (this build writes v${FORMAT_VERSION})`);
  }
  return {
    version,
    metricId: buf.readUInt16LE(6),
    baseTimestamp: Number(buf.readBigInt64LE(8)),
  };
}

/** Write one record into `buf` at `offset` (needs {@link RECORD_SIZE} bytes of room). */
export function encodeRecord(buf: Buffer, offset: number, timestamp: number, value: number): void {
  buf.writeBigInt64LE(toInt64(timestamp, 'timestamp'), offset);
  buf.writeDoubleLE(value, offset + 8);
}

/** Decode one record from `buf` at `offset`. */
export function decodeRecord(buf: Buffer, offset: number): { timestamp: number; value: number } {
  return {
    timestamp: Number(buf.readBigInt64LE(offset)),
    value: buf.readDoubleLE(offset + 8),
  };
}

/** Byte offset of record `index` within the file. The O(1) addressing primitive. */
export function recordOffset(index: number): number {
  return HEADER_SIZE + index * RECORD_SIZE;
}
