# shrekDB

**A local-first time-series core, in TypeScript.**

A compact binary `.shrekdb` file format with O(1) random access, binary-search
time-window queries, and **LTTB** downsampling for high-velocity charting of
millions of points.

> Originally specced as LuminaDB (a Tauri UI over a Java storage core), this is
> the storage core rebuilt in TypeScript so the whole stack can live in one
> language — usable as a library or via the bundled `shrekdb` CLI.

## Install

```bash
npm install
npm test          # run the suite
npm run demo      # write 1M points, query + downsample
npm run build     # emit dist/
```

Requires Node 18+ (uses `fs/promises` positional reads and `BigInt64` buffers).

> **Note:** on this machine Node lives at `C:\Program Files\nodejs` but isn't on
> the PowerShell PATH. Either add that folder to PATH, or prefix commands with
> `$env:Path = "C:\Program Files\nodejs;" + $env:Path` for the session.

## Try it (CLI)

The fastest way to kick the tires — no code required. With dev tooling:

```bash
# 1. Generate a synthetic 1,000,000-point file
npm run cli -- gen demo.shrekdb --count 1000000

# 2. Inspect it
npm run cli -- info demo.shrekdb

# 3. Query the whole series, downsampled to 20 points
npm run cli -- query demo.shrekdb --max 20

# 4. Query a time window (epoch ms or ISO-8601) as JSON
npm run cli -- query demo.shrekdb --from 2026-01-01 --to 2026-01-02 --max 100 --json

# 5. Ingest your own CSV ("timestamp,value")
npm run cli -- ingest examples/sample.csv mydata.shrekdb
npm run cli -- head mydata.shrekdb

# 6. Aggregate stats over a window
npm run cli -- stats demo.shrekdb --from 2026-01-01 --to 2026-02-01

# 7. Append more rows to an existing file (must not predate its last row)
npm run cli -- append mydata.shrekdb more.csv

# 8. Export a (optionally downsampled) window back to CSV
npm run cli -- export demo.shrekdb --max 1000 > rollup.csv

# 9. Write a downsampled copy to a new .shrekdb file
npm run cli -- rollup demo.shrekdb demo-1k.shrekdb --max 1000
```

After `npm run build`, the same CLI is available as `node dist/cli.js <command>`
(or as the `shrekdb` bin if the package is installed globally). Run
`npm run cli -- help` for the full command list.

## Live chart

`serve` starts a tiny zero-dependency web server with an interactive,
zoomable canvas chart of a file — the visible half of the original spec
(the SDD's Tauri canvas charts), here as a plain browser page:

```bash
npm run cli -- gen demo.shrekdb --count 1000000
npm run cli -- serve demo.shrekdb --port 8787   # → http://127.0.0.1:8787
```

Open the URL and **drag horizontally to zoom**; double-click to reset. On every
view change the browser asks the server for an LTTB query at exactly its pixel
width, so a million-point series renders as ~1 point per pixel and anomaly
spikes survive at any zoom level. The server exposes two read-only endpoints
backed by `ShrekReader`:

| Endpoint | Returns |
| --- | --- |
| `GET /api/info` | `{ metricId, count, from, to }` |
| `GET /api/query?from=&to=&max=` | `{ total, points }` — `total` is the pre-downsample window size |

It binds to loopback and to the single file you pass on the command line (no path
comes from the request), so there's no path-traversal surface.

## Quick start (library)

```ts
import { TimeSeriesStore } from 'shrekdb';

// Write a series (sorted by timestamp for you).
const store = await TimeSeriesStore.writeAll('cpu.shrekdb', samples, { metricId: 7 });

// Query a time window, downsampled to ~800 points for a chart.
const points = await store.query({
  from: Date.UTC(2026, 0, 1),
  to:   Date.UTC(2026, 0, 8),
  maxPoints: 800,
});
```

Or ingest a CSV directly:

```ts
await TimeSeriesStore.ingestCsv('cpu.shrekdb', csvText); // columns: timestamp,value
```

Drop down to the low-level reader for random access:

```ts
import { ShrekReader } from 'shrekdb';

const reader = await ShrekReader.open('cpu.shrekdb');
const record = await reader.readRecord(500_000); // O(1) — one read at a computed offset
await reader.close();
```

## The `.shrekdb` format

Fixed-size header + fixed-size records, little-endian. Because every record is
exactly 16 bytes, the byte offset of record *i* is pure arithmetic — no scanning:

```
offset(i) = HEADER_SIZE + i * RECORD_SIZE   //  16 + i * 16

┌──────────────── HEADER (16 bytes) ─────────────────┐
│ magic "SHRK" 4B │ version 2B │ metricId 2B │ base 8B │
├──────────────── RECORDS (16 bytes each) ───────────┤
│ timestamp 8B (int64) │ value 8B (float64)           │  × N
└────────────────────────────────────────────────────┘
```

| Field        | Bytes | Type    | Notes                                  |
| ------------ | ----- | ------- | -------------------------------------- |
| magic        | 4     | ascii   | `SHRK` — validates the file            |
| version      | 2     | uint16  | layout version (current: `1`)          |
| metricId     | 2     | uint16  | sensor / telemetry category code       |
| baseTimestamp| 8     | int64   | epoch ms when recording started        |
| *record* ts  | 8     | int64   | epoch ms                               |
| *record* val | 8     | float64 | IEEE-754 double                        |

## How queries work

1. **Random access** — `readRecord(i)` reads exactly 16 bytes at `offset(i)`.
2. **Time window** — `query({from, to})` binary-searches the (sorted) records for
   the first index `≥ from` and the first index `> to`, then reads that block in a
   single I/O. Bounds are inclusive and clamped to the series.
3. **Downsampling** — if the window exceeds `maxPoints`, the block is reduced with
   **LTTB** (Largest-Triangle-Three-Buckets), which preserves peaks and troughs
   instead of naively decimating. A 120-unit spike inside a million-point series
   still shows up at 800-point resolution (`npm run demo` proves it).

> **Memory-mapping note.** Node has no portable `mmap`, so the reader uses
> positional `FileHandle.read`. The OS page cache makes repeated reads cheap, and
> we only ever request the exact byte ranges we need — the same "touch only the
> target bytes" behaviour the SDD asks of `MappedByteBuffer`.

## Project layout

```
shrekDB/
├── src/
│   ├── format.ts   # .shrekdb binary codec (header + records, offset math)
│   ├── writer.ts   # ShrekWriter — append-only writer (create + open-to-append)
│   ├── reader.ts   # ShrekReader — random access, window queries, stats
│   ├── lttb.ts     # LTTB downsampling
│   ├── csv.ts      # CSV → samples ingestion
│   ├── store.ts    # TimeSeriesStore — writeAll / ingestCsv / append / query
│   ├── server.ts   # zero-dep HTTP query API for the chart UI
│   ├── cli.ts      # shrekdb command-line interface
│   ├── types.ts    # shared types
│   └── index.ts    # public API
├── public/
│   └── index.html  # interactive canvas chart (drag-to-zoom, live LTTB)
├── test/           # vitest suite (format, lttb, reader, store, extensions)
└── examples/
    ├── demo.ts     # 1M-point write → query → downsample
    └── sample.csv  # tiny CSV for `shrekdb ingest`
```

## API

| Export                 | What it is                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| `TimeSeriesStore`      | High-level façade: `writeAll`, `ingestCsv`, `append`, `query`, `open` |
| `ShrekWriter`          | Append-only `.shrekdb` writer (`create` + `open` to extend)       |
| `ShrekReader`          | Random access + `query()` + `stats()` + `windowCount()`           |
| `serve(file, opts)`    | Start the chart query server; returns the `http.Server`           |
| `lttb(data, n)`        | Downsample to `n` points, shape-preserving                        |
| `parseCsv(text, opts)` | Parse `timestamp,value` CSV into samples                          |
| `encode/decodeHeader`, `encode/decodeRecord`, `recordOffset` | Low-level codec |

## License

[MIT](LICENSE) © Vivaan Dudeja
