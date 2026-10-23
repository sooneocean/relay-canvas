import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { MediaStore } from '../server/media.js';
import { readPolicy } from '../server/security.js';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import type { Artifact } from '../src/shared/types.js';

const require = createRequire(import.meta.url);
const nativeFs = require('node:fs') as typeof import('node:fs');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-media-stream-'));
  const bytes = readFileSync(path.join(process.cwd(), 'public', 'demo-motion.mp4'));
  const store = new Store(directory);
  const media = new MediaStore(directory, readPolicy({}));
  let artifact: Artifact | undefined;
  await media.save({ kind: 'video', url: `data:video/mp4;base64,${bytes.toString('base64')}` }, saved => { artifact = saved; });
  const board = store.read().boards[0];
  store.transaction(data => {
    data.runs.push({
      id: 'media-stream-run', boardId: board.id, revision: board.revision, operationId: 'media-stream-operation',
      status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: board,
      providers: data.providers, order: ['media'], results: { media: { nodeId: 'media', status: 'succeeded', artifacts: [artifact!] } },
    });
  });
  const service = new CanvasService(store, readPolicy({}), undefined, media);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const { app, token } = createApp(service, origin, 'e'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const headers = { Origin: origin, 'X-Canvas-Token': token };
  return {
    artifact: artifact!, bytes, directory, headers, media, origin, server,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('media EOF has one lease owner and never schedules a stale native close against a reused descriptor', async () => {
  const context = await fixture();
  const originalClose = nativeFs.close;
  const originalCreateReadStream = nativeFs.createReadStream;
  let servedStream: ReturnType<typeof nativeFs.createReadStream> | undefined;
  const delayedCloses: Array<() => Promise<void>> = [];
  const released: number[] = [];
  const originalRelease = context.media.releaseFile.bind(context.media);
  context.media.releaseFile = fd => { released.push(fd); originalRelease(fd); };
  nativeFs.close = ((fd: number, callback: (error?: NodeJS.ErrnoException | null) => void) => {
    delayedCloses.push(() => new Promise(resolve => {
      originalClose(fd, error => { callback(error); resolve(); });
    }));
  }) as typeof nativeFs.close;
  nativeFs.createReadStream = ((...args: Parameters<typeof nativeFs.createReadStream>) => {
    servedStream = originalCreateReadStream(...args);
    return servedStream;
  }) as typeof nativeFs.createReadStream;
  syncBuiltinESMExports();
  const sentinelFds: number[] = [];
  try {
    const response = await fetch(`${context.origin}${context.artifact.localUrl}`, { headers: context.headers });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), context.bytes);
    await waitFor(() => context.media.openFileCount() === 0, 'media lease did not close after EOF');
    // Receiving the HTTP body is earlier than response.close on some runtimes.
    // Await actual stream destruction before inspecting a possible second close.
    await waitFor(() => servedStream?.destroyed === true, 'response completion did not destroy its media stream');
    assert.equal(released.length, 1);

    const sentinel = path.join(context.directory, 'sentinel');
    writeFileSync(sentinel, 'sentinel', { mode: 0o600 });
    for (let attempt = 0; attempt < 256; attempt++) {
      const fd = openSync(sentinel, 'r');
      sentinelFds.push(fd);
      if (fd >= released[0]) break;
    }
    const sentinelFd = sentinelFds.at(-1)!;
    assert.equal(sentinelFd, released[0], 'the regression requires deterministic numeric FD reuse');
    const delayedCloseCount = delayedCloses.length;
    await Promise.all(delayedCloses.splice(0).map(close => close()));
    assert.equal(fstatSync(sentinelFd).isFile(), true);
    assert.equal(delayedCloseCount, 0, 'ReadStream must not retain a second native close after releasing the lease');
  } finally {
    nativeFs.close = originalClose;
    nativeFs.createReadStream = originalCreateReadStream;
    syncBuiltinESMExports();
    await Promise.all(delayedCloses.splice(0).map(close => close()));
    for (const fd of sentinelFds) try { closeSync(fd); } catch { /* a regression may already have closed it */ }
    await context.close();
  }
});

test('media abort waits for the pending read and cannot later close a reused descriptor', async () => {
  const context = await fixture();
  const originalRead = nativeFs.read;
  const originalClose = nativeFs.close;
  const originalCreateReadStream = nativeFs.createReadStream;
  const originalRelease = context.media.releaseFile.bind(context.media);
  const released: number[] = [];
  const delayedCloses: Array<() => Promise<void>> = [];
  const sentinelFds: number[] = [];
  let servedStream: ReturnType<typeof nativeFs.createReadStream> | undefined;
  let completeRead: (() => void) | undefined;
  context.media.releaseFile = fd => { released.push(fd); originalRelease(fd); };
  nativeFs.read = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null, callback: (...args: unknown[]) => void) => {
    originalRead(fd, buffer, offset, length, position, (...args: unknown[]) => {
      completeRead = () => callback(...args);
    });
  }) as typeof nativeFs.read;
  nativeFs.close = ((fd: number, callback: (error?: NodeJS.ErrnoException | null) => void) => {
    delayedCloses.push(() => new Promise(resolve => {
      originalClose(fd, error => { callback(error); resolve(); });
    }));
  }) as typeof nativeFs.close;
  nativeFs.createReadStream = ((...args: Parameters<typeof nativeFs.createReadStream>) => {
    servedStream = originalCreateReadStream(...args);
    return servedStream;
  }) as typeof nativeFs.createReadStream;
  syncBuiltinESMExports();
  const request = http.get(`${context.origin}${context.artifact.localUrl}`, { headers: context.headers });
  request.on('error', () => undefined); // This request is explicitly cancelled.
  try {
    await waitFor(() => completeRead !== undefined, 'media read did not reach the held callback');
    request.destroy();
    await waitFor(() => servedStream?.destroyed === true, 'server did not observe the cancelled request');
    const leasesWhileReadPending = context.media.openFileCount();
    const finishRead = completeRead!;
    completeRead = undefined;
    finishRead();
    await waitFor(() => delayedCloses.length > 0 || servedStream?.closed === true, 'media close did not complete or reach its native callback');
    assert.equal(released.length, 1);
    const sentinel = path.join(context.directory, 'pending-read-sentinel');
    writeFileSync(sentinel, 'sentinel', { mode: 0o600 });
    for (let attempt = 0; attempt < 256; attempt++) {
      const fd = openSync(sentinel, 'r');
      sentinelFds.push(fd);
      if (fd >= released[0]) break;
    }
    const sentinelFd = sentinelFds.at(-1)!;
    assert.equal(sentinelFd, released[0], 'the pending-read regression must exercise actual descriptor reuse');
    const nativeCloseCount = delayedCloses.length;
    await Promise.all(delayedCloses.splice(0).map(close => close()));
    assert.equal(fstatSync(sentinelFd).isFile(), true, 'a completed old stream must not close a later file');
    assert.equal(nativeCloseCount, 0, 'lease closure must not leave a second native close');
    assert.equal(leasesWhileReadPending, 1, 'an aborted stream must retain its lease until the pending read completes');
    assert.equal(context.media.openFileCount(), 0);
  } finally {
    nativeFs.read = originalRead;
    nativeFs.close = originalClose;
    nativeFs.createReadStream = originalCreateReadStream;
    syncBuiltinESMExports();
    request.destroy();
    completeRead?.();
    await Promise.all(delayedCloses.splice(0).map(close => close()));
    for (const fd of sentinelFds) try { closeSync(fd); } catch { /* a failing old handler may already have closed it */ }
    await context.close();
  }
});

test('concurrent full, Range, and aborted media requests preserve exact responses and release each lease once', async () => {
  const context = await fixture();
  const originalRead = nativeFs.read;
  const released: number[] = [];
  const originalRelease = context.media.releaseFile.bind(context.media);
  context.media.releaseFile = fd => { released.push(fd); originalRelease(fd); };
  nativeFs.read = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null, callback: (...args: unknown[]) => void) => {
    originalRead(fd, buffer, offset, length, position, (...args: unknown[]) => { setTimeout(() => callback(...args), 25); });
  }) as typeof nativeFs.read;
  syncBuiltinESMExports();
  try {
    const url = `${context.origin}${context.artifact.localUrl}`;
    const full = fetch(url, { headers: context.headers });
    const firstRange = fetch(url, { headers: { ...context.headers, Range: 'bytes=0-999' } });
    const secondRange = fetch(url, { headers: { ...context.headers, Range: 'bytes=1000-1999' } });
    const aborted = http.get(url, { headers: context.headers });
    aborted.on('error', () => undefined);
    await waitFor(() => context.media.openFileCount() === 4, 'concurrent media streams did not all acquire leases');
    aborted.destroy();

    const [fullResponse, firstResponse, secondResponse] = await Promise.all([full, firstRange, secondRange]);
    assert.equal(fullResponse.status, 200);
    assert.equal(fullResponse.headers.get('content-length'), String(context.bytes.length));
    assert.deepEqual(Buffer.from(await fullResponse.arrayBuffer()), context.bytes);
    assert.equal(firstResponse.status, 206);
    assert.equal(firstResponse.headers.get('content-range'), `bytes 0-999/${context.bytes.length}`);
    assert.equal(firstResponse.headers.get('content-length'), '1000');
    assert.deepEqual(Buffer.from(await firstResponse.arrayBuffer()), context.bytes.subarray(0, 1000));
    assert.equal(secondResponse.status, 206);
    assert.equal(secondResponse.headers.get('content-range'), `bytes 1000-1999/${context.bytes.length}`);
    assert.equal(secondResponse.headers.get('content-length'), '1000');
    assert.deepEqual(Buffer.from(await secondResponse.arrayBuffer()), context.bytes.subarray(1000, 2000));
    await waitFor(() => context.media.openFileCount() === 0, 'concurrent media leases did not all close');
    assert.equal(released.length, 4);
    assert.equal(new Set(released).size, 4);
  } finally {
    nativeFs.read = originalRead;
    syncBuiltinESMExports();
    await context.close();
  }
});

test('media read and stream construction errors, HEAD, and invalid multi-ranges each release exactly one lease', async () => {
  const context = await fixture();
  const originalRead = nativeFs.read;
  const originalCreateReadStream = nativeFs.createReadStream;
  const released: number[] = [];
  const originalRelease = context.media.releaseFile.bind(context.media);
  context.media.releaseFile = fd => { released.push(fd); originalRelease(fd); };
  try {
    const head = await fetch(`${context.origin}${context.artifact.localUrl}`, { method: 'HEAD', headers: context.headers });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(released.length, 1);

    const invalid = await fetch(`${context.origin}${context.artifact.localUrl}`, { headers: { ...context.headers, Range: 'bytes=0-1,3-4' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${context.bytes.length}`);
    assert.equal(released.length, 2);

    nativeFs.read = ((_fd: number, _buffer: NodeJS.ArrayBufferView, _offset: number, _length: number, _position: number | null, callback: (error: NodeJS.ErrnoException) => void) => {
      const error = Object.assign(new Error('fixture read failure'), { code: 'EIO' });
      setImmediate(() => callback(error));
    }) as typeof nativeFs.read;
    syncBuiltinESMExports();
    const failed = http.get(`${context.origin}${context.artifact.localUrl}`, { headers: context.headers });
    failed.on('error', () => undefined);
    await new Promise<void>(resolve => failed.once('close', resolve));
    await waitFor(() => context.media.openFileCount() === 0, 'read-error media lease did not close');
    assert.equal(released.length, 3);

    nativeFs.read = originalRead;
    nativeFs.createReadStream = (() => { throw new Error('fixture constructor failure'); }) as typeof nativeFs.createReadStream;
    syncBuiltinESMExports();
    const constructorFailure = await fetch(`${context.origin}${context.artifact.localUrl}`, { headers: context.headers });
    assert.equal(constructorFailure.status, 400);
    assert.equal(context.media.openFileCount(), 0);
    assert.equal(released.length, 4);
  } finally {
    nativeFs.read = originalRead;
    nativeFs.createReadStream = originalCreateReadStream;
    syncBuiltinESMExports();
    await context.close();
  }
});
