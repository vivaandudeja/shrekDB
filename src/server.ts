import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ShrekReader } from './reader.js';

/** Options for {@link serve}. */
export interface ServeOptions {
  /** TCP port. Defaults to 8787. */
  port?: number;
  /** Bind address. Defaults to 127.0.0.1 (loopback only). */
  host?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/server.js → ../public, and src/server.ts (via tsx) → ../public. Both land on the repo's public/.
const INDEX_HTML = join(HERE, '..', 'public', 'index.html');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseNum(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Start a tiny HTTP server that serves the chart page and a read-only query API
 * backed by a single `.shrekdb` file. It's the local stand-in for the SDD's IPC
 * channel — the browser fires `GET /api/query`, the core answers with a
 * downsampled array. Bound to loopback and to one fixed file (no path comes from
 * the request), so there's no path-traversal surface.
 *
 * @returns the listening {@link Server} (already accepting connections).
 */
export async function serve(filePath: string, opts: ServeOptions = {}): Promise<Server> {
  const port = opts.port ?? 8787;
  const host = opts.host ?? '127.0.0.1';

  // Fail fast if the file is missing or not a valid .shrekdb.
  await (await ShrekReader.open(filePath)).close();

  const server = createServer((req, res) => {
    void handle(req.method, req.url, req.headers.host, filePath, host, res).catch((err: unknown) => {
      // Only send a 500 if nothing has been written yet — a rejection *after* the
      // response is committed (e.g. a post-send I/O error) must not double-send,
      // which would throw ERR_HTTP_HEADERS_SENT as an unhandled rejection.
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

async function handle(
  method: string | undefined,
  reqUrl: string | undefined,
  hostHeader: string | undefined,
  filePath: string,
  host: string,
  res: ServerResponse,
): Promise<void> {
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  const url = new URL(reqUrl ?? '/', `http://${hostHeader ?? host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = await readFile(INDEX_HTML);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (url.pathname === '/api/info') {
    const reader = await ShrekReader.open(filePath);
    try {
      const first = reader.count > 0 ? await reader.readRecord(0) : null;
      const last = reader.count > 0 ? await reader.readRecord(reader.count - 1) : null;
      sendJson(res, 200, {
        metricId: reader.header.metricId,
        count: reader.count,
        from: first?.timestamp ?? null,
        to: last?.timestamp ?? null,
      });
    } finally {
      await reader.close();
    }
    return;
  }

  if (url.pathname === '/api/query') {
    const from = parseNum(url.searchParams.get('from'));
    const to = parseNum(url.searchParams.get('to'));
    const max = parseNum(url.searchParams.get('max'));
    const reader = await ShrekReader.open(filePath);
    try {
      // `total` is the pre-downsample window size, so the UI can show the ratio.
      const total = await reader.windowCount({ from, to });
      const points = await reader.query({ from, to, maxPoints: max });
      sendJson(res, 200, { total, points });
    } finally {
      await reader.close();
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
