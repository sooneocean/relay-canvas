import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { createSourceFixture } from './v07-source-fixture.js';

/** Real Node HTTP parsing, client disconnect and production30s upload deadline.
 * All connections stay on the isolated loopback fixture. No shortened timer. */
export async function verifyImportNetwork(fixture: Awaited<ReturnType<typeof createSourceFixture>>) {
  const url = new URL(fixture.origin);
  const png = readFileSync(fixture.files['local-green.png']);
  const counters = () => ({
    active: (fixture.service as unknown as { activeImports: number }).activeImports,
    reserved: (fixture.service.media as unknown as { reservedBytes(): number }).reservedBytes(),
    temp: readdirSync(fixture.service.media.directory).filter(name => name.endsWith('.import')).length,
  });
  const until = async (probe: () => boolean, timeout = 3000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (probe()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(probe(), 'Import network resources did not settle');
  };
  const header = (operationId: string, length: number, duplicate = false) => {
    const query = new URLSearchParams({ expectedRevision: '0', operationId, kind: 'image', name: 'network-fixture.png' });
    return `POST /api/boards/${fixture.fixtureBoard.id}/imports?${query} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${fixture.origin}\r\nX-Canvas-Token: ${fixture.token}\r\nContent-Type: image/png\r\nContent-Length: ${length}\r\n${duplicate ? `Content-Length: ${length}\r\n` : ''}Connection: close\r\n\r\n`;
  };
  const socket = async () => {
    const connection = net.connect(Number(url.port), '127.0.0.1');
    await new Promise<void>((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject); });
    // Expected disconnect/reset paths must not become unhandled EventEmitter errors.
    connection.on('error', () => {});
    return connection;
  };
  const before = fixture.store.read();
  const duplicate = await socket(); let duplicateResponse = '';
  duplicate.on('data', bytes => { duplicateResponse += bytes.toString('utf8'); });
  const duplicateClosed = new Promise<void>(resolve => duplicate.once('close', () => resolve()));
  duplicate.end(Buffer.concat([Buffer.from(header(randomUUID(), png.length, true)), png]));
  await duplicateClosed;
  assert.match(duplicateResponse, /^HTTP\/1\.1 400 /);
  assert.deepEqual(counters(), { active: 0, reserved: 0, temp: 0 });
  const disconnected = await socket();
  disconnected.write(header(randomUUID(), png.length)); disconnected.write(png.subarray(0, 8));
  await until(() => counters().active === 1);
  disconnected.destroy();
  await until(() => counters().active === 0 && counters().reserved === 0 && counters().temp === 0);
  const stalled = await socket();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const start = Date.now();
  const closed = new Promise<void>((resolve, reject) => {
    stalled.once('close', () => resolve());
    watchdog = setTimeout(() => { stalled.destroy(); reject(new Error('Production import deadline exceeded40seconds')); }, 40000);
  });
  try {
    stalled.write(header(randomUUID(), png.length)); stalled.write(png.subarray(0, 8));
    await until(() => counters().active === 1);
    await closed;
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 29000 && elapsed < 40000, `Production deadline elapsed ${elapsed}ms`);
    await until(() => counters().active === 0 && counters().reserved === 0 && counters().temp === 0);
    assert.deepEqual(fixture.store.read(), before, 'Rejected/aborted/timedout uploads leave no registry/node/run mutation');
    assert.deepEqual(fixture.submissions(), { images: 0, videos: 0, localReferences: 0 });
    return { duplicateContentLength: '400-before-mutation', socketDisconnect: 'resources-released', productionDeadlineMs: elapsed, resources: counters() };
  } finally { if (watchdog) clearTimeout(watchdog); stalled.destroy(); }
}
