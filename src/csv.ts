import type { Sample } from './types.js';

/** Options controlling how a CSV string is parsed into {@link Sample}s. */
export interface CsvParseOptions {
  /** Field delimiter. Defaults to ",". */
  delimiter?: string;
  /** Zero-based column index holding the timestamp. Defaults to 0. */
  timestampColumn?: number;
  /** Zero-based column index holding the value. Defaults to 1. */
  valueColumn?: number;
}

/**
 * Parse a numeric cell, treating an empty cell as invalid.
 *
 * `Number('')` is `0`, not `NaN`, which would silently turn missing fields into
 * zeros — so empty/whitespace cells are explicitly rejected here.
 */
function parseNumberCell(raw: string): number {
  if (raw === '') return Number.NaN;
  return Number(raw);
}

/** Parse a timestamp cell as epoch ms, falling back to `Date.parse` for ISO strings. */
function parseTimestamp(raw: string): number {
  const n = parseNumberCell(raw);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * Parse two columns of a CSV into samples.
 *
 * Rows whose timestamp or value does not parse to a finite number are skipped,
 * which transparently handles a header row, blank lines, and short rows.
 */
export function parseCsv(text: string, opts: CsvParseOptions = {}): Sample[] {
  const delimiter = opts.delimiter ?? ',';
  const tsCol = opts.timestampColumn ?? 0;
  const valCol = opts.valueColumn ?? 1;

  const out: Sample[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const cols = trimmed.split(delimiter);
    const timestamp = parseTimestamp((cols[tsCol] ?? '').trim());
    const value = parseNumberCell((cols[valCol] ?? '').trim());
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;

    out.push({ timestamp, value });
  }
  return out;
}
