import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { TimeSeriesStore, type Sample } from '../src/index.js';

/** Build a noisy sine wave with a couple of sharp spikes to prove LTTB keeps shape. */
function syntheticSeries(count: number, startMs: number, stepMs: number): Sample[] {
  const out: Sample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let value = Math.sin(i / 120) * 10 + Math.sin(i / 13) * 1.5;
    if (i === Math.floor(count * 0.33)) value = 120; // spike up
    if (i === Math.floor(count * 0.66)) value = -90; // spike down
    out[i] = { timestamp: startMs + i * stepMs, value };
  }
  return out;
}

async function main(): Promise<void> {
  const path = join(tmpdir(), `shrekdb-demo-${process.pid}.shrekdb`);
  const start = Date.UTC(2026, 0, 1);
  const stepMs = 60_000; // one point per minute
  const total = 1_000_000;

  console.log(`Generating ${total.toLocaleString()} samples…`);
  const samples = syntheticSeries(total, start, stepMs);

  console.time('write');
  const store = await TimeSeriesStore.writeAll(path, samples, {
    metricId: 7,
    presorted: true,
  });
  console.timeEnd('write');

  const reader = await store.open();
  console.log(
    `\nFile: ${path}\n` +
      `  metricId=${reader.header.metricId}  records=${reader.count.toLocaleString()}  ` +
      `bytes≈${(16 + reader.count * 16).toLocaleString()}`,
  );

  // Random access — touch one record deep in the file.
  const mid = await reader.readRecord(Math.floor(total / 2));
  console.log(`  random record[500000] = ${mid.value.toFixed(4)} @ ${new Date(mid.timestamp).toISOString()}`);
  await reader.close();

  // Query the full series and downsample to a chart-friendly width.
  console.time('query+downsample');
  const points = await store.query({ maxPoints: 800 });
  console.timeEnd('query+downsample');

  const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
  console.log(
    `\nQueried full series → ${points.length} points (downsampled from ${total.toLocaleString()}).\n` +
      `  preserved peak = ${peak.value.toFixed(2)} → 120-spike survives downsampling: ${peak.value === 120}`,
  );

  await rm(path, { force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
