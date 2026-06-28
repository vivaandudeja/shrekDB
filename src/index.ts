/**
 * shrekDB — a local-first time-series core, in TypeScript.
 *
 * A compact binary `.shrekdb` file format with O(1) random access, binary-search
 * time-window queries, and LTTB downsampling for high-velocity charting.
 */

export type { Sample, ShrekHeader, QueryOptions, Stats } from './types.js';

export {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  RECORD_SIZE,
  ShrekFormatError,
  encodeHeader,
  decodeHeader,
  encodeRecord,
  decodeRecord,
  recordOffset,
} from './format.js';

export { lttb } from './lttb.js';
export { ShrekWriter, type WriterOptions } from './writer.js';
export { ShrekReader } from './reader.js';
export { parseCsv, type CsvParseOptions } from './csv.js';
export { TimeSeriesStore, type WriteOptions } from './store.js';
export { serve, type ServeOptions } from './server.js';
