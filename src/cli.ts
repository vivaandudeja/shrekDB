#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { TimeSeriesStore } from './store.js';
import { ShrekReader } from './reader.js';
import { parseCsv } from './csv.js';
import type { Sample } from './types.js';

/** Flags that never take a value, so they don't swallow the next token. */
const BOOLEAN_FLAGS = new Set(['json']);

/** Minimal flag parser: splits `--key value` / `--flag` from positionals. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Parse a time flag as epoch ms or an ISO-8601 string. */
function parseTime(raw: string | true | undefined, label: string): number | undefined {
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`Invalid ${label} time: "${raw}" (use epoch ms or ISO-8601)`);
  return parsed;
}

function parseIntFlag(raw: string | true | undefined, label: string): number | undefined {
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${label} must be an integer, got "${raw}"`);
  return n;
}

const HELP = `shrekdb — time-series storage CLI

Usage:
  shrekdb gen <out.shrekdb> [--count N] [--metric ID]
      Generate a synthetic series (sine wave + spikes) for quick testing.

  shrekdb ingest <in.csv> <out.shrekdb> [--metric ID]
                 [--delimiter C] [--ts-col N] [--val-col N]
      Parse a "timestamp,value" CSV and write a .shrekdb file.

  shrekdb info <file.shrekdb>
      Print header + record count + time span.

  shrekdb head <file.shrekdb> [--n N]
      Print the first N records (default 10).

  shrekdb query <file.shrekdb> [--from T] [--to T] [--max N] [--json]
      Query a time window (T = epoch ms or ISO-8601), optionally downsampled
      to --max points with LTTB. Default output is a table; --json prints JSON.

  shrekdb append <file.shrekdb> <more.csv>
                 [--delimiter C] [--ts-col N] [--val-col N]
      Append rows from a CSV to an existing file (must not predate its last row).

  shrekdb stats <file.shrekdb> [--from T] [--to T]
      Print count / min / max / mean / sum over a time window.

  shrekdb export <file.shrekdb> [--from T] [--to T] [--max N]
      Print the window as "timestamp,value" CSV (redirect to a file to save).

  shrekdb rollup <in.shrekdb> <out.shrekdb> --max N [--from T] [--to T]
      Downsample a window to N points and write them to a new .shrekdb file.

  shrekdb serve <file.shrekdb> [--port N]
      Start a local web server with an interactive zoomable chart of the file.

Examples:
  shrekdb gen demo.shrekdb --count 1000000
  shrekdb info demo.shrekdb
  shrekdb query demo.shrekdb --max 20
  shrekdb stats demo.shrekdb --from 2026-01-01 --to 2026-02-01
  shrekdb serve demo.shrekdb --port 8787`;

/** Synthetic sine wave with two sharp spikes — same shape the demo uses. */
function syntheticSeries(count: number): Sample[] {
  const start = Date.UTC(2026, 0, 1);
  const stepMs = 60_000; // one point per minute
  const out: Sample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let value = Math.sin(i / 120) * 10 + Math.sin(i / 13) * 1.5;
    if (count > 3 && i === Math.floor(count * 0.33)) value = 120;
    if (count > 3 && i === Math.floor(count * 0.66)) value = -90;
    out[i] = { timestamp: start + i * stepMs, value };
  }
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function printTable(rows: Sample[]): void {
  if (rows.length === 0) {
    console.log('(no records)');
    return;
  }
  console.log('timestamp (ISO)'.padEnd(26) + 'value');
  console.log('-'.repeat(26) + '-----');
  for (const r of rows) {
    console.log(iso(r.timestamp).padEnd(26) + r.value.toString());
  }
}

async function cmdGen(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const out = positional[0];
  if (!out) throw new Error('gen requires an output path: shrekdb gen <out.shrekdb>');
  const count = parseIntFlag(flags.count, 'count') ?? 100_000;
  if (count < 0) throw new Error('--count must be non-negative');
  const metricId = parseIntFlag(flags.metric, 'metric') ?? 0;

  await TimeSeriesStore.writeAll(out, syntheticSeries(count), { metricId, presorted: true });
  console.log(`Wrote ${count.toLocaleString()} records to ${out} (metricId=${metricId}).`);
}

async function cmdIngest(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const [input, out] = positional;
  if (!input || !out) throw new Error('ingest requires: shrekdb ingest <in.csv> <out.shrekdb>');
  const csv = await readFile(input, 'utf8');
  const store = await TimeSeriesStore.ingestCsv(out, csv, {
    metricId: parseIntFlag(flags.metric, 'metric'),
    delimiter: typeof flags.delimiter === 'string' ? flags.delimiter : undefined,
    timestampColumn: parseIntFlag(flags['ts-col'], 'ts-col'),
    valueColumn: parseIntFlag(flags['val-col'], 'val-col'),
  });
  const reader = await store.open();
  console.log(`Ingested ${reader.count.toLocaleString()} records from ${input} → ${out}.`);
  await reader.close();
}

async function cmdInfo(positional: string[]): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('info requires: shrekdb info <file.shrekdb>');
  const reader = await ShrekReader.open(file);
  try {
    const bytes = 16 + reader.count * 16;
    console.log(`File:      ${file}`);
    console.log(`Version:   ${reader.header.version}`);
    console.log(`MetricId:  ${reader.header.metricId}`);
    console.log(`Records:   ${reader.count.toLocaleString()}`);
    console.log(`Size:      ${bytes.toLocaleString()} bytes`);
    if (reader.count > 0) {
      const first = await reader.readRecord(0);
      const last = await reader.readRecord(reader.count - 1);
      console.log(`First:     ${iso(first.timestamp)}  (value ${first.value})`);
      console.log(`Last:      ${iso(last.timestamp)}  (value ${last.value})`);
      console.log(`Span:      ${((last.timestamp - first.timestamp) / 1000).toLocaleString()} s`);
    }
  } finally {
    await reader.close();
  }
}

async function cmdHead(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('head requires: shrekdb head <file.shrekdb>');
  const n = parseIntFlag(flags.n, 'n') ?? 10;
  const reader = await ShrekReader.open(file);
  try {
    printTable(await reader.readBlock(0, n));
  } finally {
    await reader.close();
  }
}

async function cmdQuery(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('query requires: shrekdb query <file.shrekdb>');
  const maxPoints = parseIntFlag(flags.max, 'max');
  if (maxPoints !== undefined && maxPoints < 1) {
    throw new Error('--max must be a positive integer');
  }
  const store = new TimeSeriesStore(file);
  const points = await store.query({
    from: parseTime(flags.from, 'from'),
    to: parseTime(flags.to, 'to'),
    maxPoints,
  });
  if (flags.json) {
    console.log(JSON.stringify(points));
  } else {
    printTable(points);
    console.log(`\n${points.length.toLocaleString()} points.`);
  }
}

function csvFlags(flags: Record<string, string | true>) {
  return {
    delimiter: typeof flags.delimiter === 'string' ? flags.delimiter : undefined,
    timestampColumn: parseIntFlag(flags['ts-col'], 'ts-col'),
    valueColumn: parseIntFlag(flags['val-col'], 'val-col'),
  };
}

async function cmdAppend(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const [file, csvPath] = positional;
  if (!file || !csvPath) throw new Error('append requires: shrekdb append <file.shrekdb> <more.csv>');
  const samples = parseCsv(await readFile(csvPath, 'utf8'), csvFlags(flags));
  await TimeSeriesStore.append(file, samples);
  const reader = await ShrekReader.open(file);
  console.log(
    `Appended ${samples.length.toLocaleString()} records from ${csvPath}; file now holds ${reader.count.toLocaleString()}.`,
  );
  await reader.close();
}

async function cmdStats(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('stats requires: shrekdb stats <file.shrekdb>');
  const reader = await ShrekReader.open(file);
  try {
    const s = await reader.stats({ from: parseTime(flags.from, 'from'), to: parseTime(flags.to, 'to') });
    if (!s) {
      console.log('(no records in window)');
      return;
    }
    console.log(`Count: ${s.count.toLocaleString()}`);
    console.log(`Min:   ${s.min}`);
    console.log(`Max:   ${s.max}`);
    console.log(`Mean:  ${s.mean}`);
    console.log(`Sum:   ${s.sum}`);
    console.log(`First: ${iso(s.first.timestamp)}  (${s.first.value})`);
    console.log(`Last:  ${iso(s.last.timestamp)}  (${s.last.value})`);
  } finally {
    await reader.close();
  }
}

async function cmdExport(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('export requires: shrekdb export <file.shrekdb>');
  const maxPoints = parseIntFlag(flags.max, 'max');
  if (maxPoints !== undefined && maxPoints < 1) throw new Error('--max must be a positive integer');
  const points = await new TimeSeriesStore(file).query({
    from: parseTime(flags.from, 'from'),
    to: parseTime(flags.to, 'to'),
    maxPoints,
  });
  process.stdout.write('timestamp,value\n');
  for (const p of points) process.stdout.write(`${p.timestamp},${p.value}\n`);
}

async function cmdRollup(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const [input, out] = positional;
  if (!input || !out) throw new Error('rollup requires: shrekdb rollup <in.shrekdb> <out.shrekdb> --max N');
  const maxPoints = parseIntFlag(flags.max, 'max');
  if (maxPoints === undefined || maxPoints < 1) throw new Error('rollup requires --max N (a positive integer)');

  const reader = await ShrekReader.open(input);
  const metricId = reader.header.metricId;
  await reader.close();

  const points = await new TimeSeriesStore(input).query({
    from: parseTime(flags.from, 'from'),
    to: parseTime(flags.to, 'to'),
    maxPoints,
  });
  await TimeSeriesStore.writeAll(out, points, { metricId, presorted: true });
  console.log(`Rolled up ${input} → ${out}: ${points.length.toLocaleString()} points (--max ${maxPoints}).`);
}

async function cmdServe(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0];
  if (!file) throw new Error('serve requires: shrekdb serve <file.shrekdb>');
  const port = parseIntFlag(flags.port, 'port') ?? 8787;
  const { serve } = await import('./server.js');
  await serve(file, { port });
  console.log(`shrekDB chart server → http://127.0.0.1:${port}`);
  console.log(`Serving ${file}. Press Ctrl+C to stop.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'gen':
      return cmdGen(positional, flags);
    case 'ingest':
      return cmdIngest(positional, flags);
    case 'info':
      return cmdInfo(positional);
    case 'head':
      return cmdHead(positional, flags);
    case 'query':
      return cmdQuery(positional, flags);
    case 'append':
      return cmdAppend(positional, flags);
    case 'stats':
      return cmdStats(positional, flags);
    case 'export':
      return cmdExport(positional, flags);
    case 'rollup':
      return cmdRollup(positional, flags);
    case 'serve':
      return cmdServe(positional, flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command: "${command}"\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
