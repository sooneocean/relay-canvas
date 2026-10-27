import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { verifyThumbnailLifetime } from './thumbnail-lifetime-smoke.js';

const root = process.cwd(), work = path.join(root, 'work');
mkdirSync(work, { recursive: true });
const video = readFileSync(path.join(root, 'public', 'demo-motion.mp4'));
const server = createServer((req, res) => {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/demo-motion.mp4') {
    res.writeHead(404); res.end(); return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0, end = video.length - 1, status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : Math.max(0, video.length - Number(range[2]));
    end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end;
    if (!Number.isSafeInteger(start) || start > end || start < 0) {
      res.writeHead(416, { 'Content-Range': 'bytes ' + '*' + '/' + video.length }); res.end(); return;
    }
    status = 206;
  }
  const headers: Record<string, string | number> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${video.length}`;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : video.subarray(start, end + 1));
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  await verifyThumbnailLifetime(browser, root, origin);
  writeFileSync(path.join(work, 'thumbnail-smoke-report.json'), JSON.stringify({ status: 'PASS', paidRequests: 0 }, null, 2));
  console.log('PASS: standalone VideoThumbnail capture, URL transition, unmount and decoder recovery.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(resolve));
}
