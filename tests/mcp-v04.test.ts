import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Artifact, ArtifactInfo } from '../src/shared/types.js';

function responseText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const block = content.find(entry => entry.type === 'text');
  assert.ok(block && block.type === 'text');
  assert.equal(typeof block.text, 'string');
  return block.text!;
}

test('real stdio MCP rejects invalid and extra artifact wrapper arguments before API dispatch', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-v04-'));
  const token = 'a'.repeat(64);
  const requests: Array<{ method: string; url: string }> = [];
  const source = { runId: 'run-safe', nodeId: 'node-safe', artifactIndex: 0 };
  const artifact: Artifact = {
    kind: 'video', url: '/api/media/' + 'b'.repeat(64), mimeType: 'video/mp4',
    localId: 'b'.repeat(64), localUrl: '/api/media/' + 'b'.repeat(64), bytes: 123, sha256: 'b'.repeat(64),
  };
  const http = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '' });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/runs/run-safe/artifacts/node-safe/0/save' && request.method === 'POST') response.end(JSON.stringify(artifact));
    else if (request.url === '/api/runs/run-safe/artifacts/node-safe/0/info' && request.method === 'GET') response.end(JSON.stringify({ source, artifact, media: { duration: 2, width: 640, height: 360, hasAudio: true } } satisfies ArtifactInfo));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: 'unexpected request' })); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); assert.ok(address && typeof address === 'object');
  writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, token }), { mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const client = new Client({ name: 'relay-mcp-v04-test', version: '0.4.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('server/mcp.ts')],
      cwd: process.cwd(),
      env: { ...environment, RELAY_DATA_DIR: directory },
      stderr: 'pipe',
    }));
    const saved = await client.callTool({ name: 'save_artifact', arguments: source });
    assert.equal(saved.isError, false); assert.deepEqual(JSON.parse(responseText(saved)), artifact);
    const info = await client.callTool({ name: 'get_artifact_info', arguments: source });
    assert.equal(info.isError, false); assert.deepEqual((JSON.parse(responseText(info)) as ArtifactInfo).source, source);
    assert.deepEqual(requests, [
      { method: 'POST', url: '/api/runs/run-safe/artifacts/node-safe/0/save' },
      { method: 'GET', url: '/api/runs/run-safe/artifacts/node-safe/0/info' },
    ]);
    const strictInputs: Array<[string, Record<string, unknown>]> = [
      ['read_timeline', { boardId: 'welcome' }],
      ['update_timeline', { boardId: 'welcome', expectedRevision: 0, format: 'landscape', clips: [] }],
      ['export_timeline', { boardId: 'welcome', expectedRevision: 0, operationId: 'operation-safe' }],
      ['get_export', { exportId: 'export-safe' }],
      ['cancel_export', { exportId: 'export-safe' }],
      ['compare_runs', { boardId: 'welcome', left: 'left-safe', right: 'right-safe' }],
      ['save_artifact', source],
      ['get_artifact_info', source],
    ];
    for (const [name, args] of strictInputs) {
      let rejected = false;
      try { rejected = Boolean((await client.callTool({ name, arguments: { ...args, url: 'https://invalid.example/video.mp4' } })).isError); } catch { rejected = true; }
      assert.equal(rejected, true, `${name} accepted an extra field`);
      assert.equal(requests.length, 2, `${name} dispatched extra arguments to API`);
    }
    const invalid = [
      { ...source, runId: '../escape' },
      { ...source, nodeId: 'bad/node' },
      { ...source, artifactIndex: -1 },
      { ...source, artifactIndex: 0.5 },
      { ...source, artifactIndex: 100 },
      { ...source, url: 'https://invalid.example/video.mp4' },
      { ...source, path: '/not-a-source' },
      { ...source, headers: { Authorization: 'secret' } },
      { ...source, key: 'not-a-key' },
    ];
    for (const name of ['save_artifact', 'get_artifact_info']) for (const args of invalid) {
      let rejected = false;
      try { rejected = Boolean((await client.callTool({ name, arguments: args })).isError); } catch { rejected = true; }
      assert.equal(rejected, true, `${name} accepted ${JSON.stringify(args)}`);
      assert.equal(requests.length, 2, `${name} dispatched invalid arguments to API`);
    }
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
