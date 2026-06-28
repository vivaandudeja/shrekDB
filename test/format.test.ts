import { describe, it, expect } from 'vitest';
import {
  decodeHeader,
  decodeRecord,
  encodeHeader,
  encodeRecord,
  HEADER_SIZE,
  MAGIC,
  RECORD_SIZE,
  ShrekFormatError,
  recordOffset,
} from '../src/format.js';

describe('header codec', () => {
  it('round-trips a header', () => {
    const header = { version: 1, metricId: 4242, baseTimestamp: 1_700_000_000_000 };
    const decoded = decodeHeader(encodeHeader(header));
    expect(decoded).toEqual(header);
  });

  it('starts with the SHRK magic string', () => {
    const buf = encodeHeader({ version: 1, metricId: 0, baseTimestamp: 0 });
    expect(buf.toString('ascii', 0, 4)).toBe(MAGIC);
    expect(MAGIC).toBe('SHRK');
    expect(buf.length).toBe(HEADER_SIZE);
  });

  it('rejects bad magic bytes', () => {
    const buf = encodeHeader({ version: 1, metricId: 0, baseTimestamp: 0 });
    buf.write('XXXX', 0, 'ascii');
    expect(() => decodeHeader(buf)).toThrow(ShrekFormatError);
  });

  it('rejects an out-of-range metricId', () => {
    expect(() => encodeHeader({ version: 1, metricId: 70_000, baseTimestamp: 0 })).toThrow(
      ShrekFormatError,
    );
  });

  it('rejects a short header buffer', () => {
    expect(() => decodeHeader(Buffer.alloc(8))).toThrow(ShrekFormatError);
  });
});

describe('record codec', () => {
  it('round-trips a record', () => {
    const buf = Buffer.alloc(RECORD_SIZE);
    encodeRecord(buf, 0, 1_700_000_000_123, 3.14159);
    expect(decodeRecord(buf, 0)).toEqual({ timestamp: 1_700_000_000_123, value: 3.14159 });
  });

  it('round-trips negative timestamps and values', () => {
    const buf = Buffer.alloc(RECORD_SIZE);
    encodeRecord(buf, 0, -86_400_000, -273.15);
    expect(decodeRecord(buf, 0)).toEqual({ timestamp: -86_400_000, value: -273.15 });
  });

  it('computes fixed-stride offsets', () => {
    expect(recordOffset(0)).toBe(HEADER_SIZE);
    expect(recordOffset(1)).toBe(HEADER_SIZE + RECORD_SIZE);
    expect(recordOffset(1000)).toBe(HEADER_SIZE + 1000 * RECORD_SIZE);
  });
});

describe('timestamp validation', () => {
  const buf = () => Buffer.alloc(RECORD_SIZE);

  it('rejects NaN / Infinity timestamps with a typed error', () => {
    expect(() => encodeRecord(buf(), 0, Number.NaN, 1)).toThrow(ShrekFormatError);
    expect(() => encodeRecord(buf(), 0, Number.POSITIVE_INFINITY, 1)).toThrow(ShrekFormatError);
    expect(() => encodeRecord(buf(), 0, Number.NEGATIVE_INFINITY, 1)).toThrow(ShrekFormatError);
    expect(() => encodeHeader({ version: 1, metricId: 0, baseTimestamp: Number.NaN })).toThrow(
      ShrekFormatError,
    );
  });

  it('rejects timestamps outside the int64 range', () => {
    expect(() => encodeRecord(buf(), 0, 1e25, 1)).toThrow(ShrekFormatError);
  });

  it('still accepts NaN / Infinity *values* (stored as float64)', () => {
    const b = buf();
    encodeRecord(b, 0, 1000, Number.POSITIVE_INFINITY);
    expect(decodeRecord(b, 0).value).toBe(Number.POSITIVE_INFINITY);
    encodeRecord(b, 0, 1000, Number.NaN);
    expect(Number.isNaN(decodeRecord(b, 0).value)).toBe(true);
  });
});
