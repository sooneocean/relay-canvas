import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import type { Browser } from '@playwright/test';

/** Exercise the shared component's actual DOM through URL change and unmount. */
export async function verifyThumbnailLifetime(browser: Browser, root: string, origin: string) {
  const entry = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import VideoThumbnail from ${JSON.stringify(path.join(root, 'src/ui/VideoThumbnail.tsx'))};
    const h = React.createElement;
    function Fixture() {
      const [src, setSrc] = useState('/demo-motion.mp4?thumbnail=A');
      const [visible, setVisible] = useState(true);
      return h(React.Fragment, null,
        h('button', { id: 'change', onClick: () => setSrc('/demo-motion.mp4?thumbnail=B') }, 'Change'),
        h('button', { id: 'remove', onClick: () => setVisible(false) }, 'Remove'),
        h('button', { id: 'invalid', onClick: () => { setSrc('/thumbnail-unreadable.mp4'); setVisible(true); } }, 'Unreadable'),
        visible && h(VideoThumbnail, { src, alt: 'Lifecycle thumbnail' })
      );
    }
    createRoot(document.getElementById('root')).render(h(Fixture));
  `;
  const output = await build({ configFile: false, root, logLevel: 'silent', esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'thumbnail-lifetime-fixture', resolveId(id) { if (id === 'virtual:thumbnail' || id.endsWith('/virtual:thumbnail')) return '\0thumbnail'; }, load(id) { if (id === '\0thumbnail') return entry; } }],
    build: { write: false, minify: false, lib: { entry: 'virtual:thumbnail', name: 'ThumbnailFixture', formats: ['iife'] } } });
  const outputs = Array.isArray(output) ? output.flatMap(item => item.output) : 'output' in output ? output.output : [];
  const script = outputs.find(item => item.type === 'chunk'); assert.ok(script && script.type === 'chunk');
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await page.route('**/thumbnail-lifetime-fixture', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><main id="root"></main></body></html>' }));
    await page.route('**/thumbnail-unreadable.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: 'Controlled undecodable thumbnail fixture' }));
    await page.goto(`${origin}/thumbnail-lifetime-fixture`);
    await page.addScriptTag({ content: script.code });
    const wait = async (probe: () => Promise<boolean>, label: string) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) { if (await probe().catch(() => false)) return; await page.waitForTimeout(50); }
      throw new Error(`Timed out: thumbnail ${label}`);
    };
    const video = () => page.getByLabel('Lifecycle thumbnail', { exact: true });
    await wait(() => video().evaluate(element => Boolean((element as HTMLVideoElement).poster)), 'A frame capture');
    const first = await video().elementHandle(); assert.ok(first);
    await page.locator('#change').click();
    await wait(() => video().evaluate(element => element.getAttribute('src')?.includes('thumbnail=B') === true && Boolean((element as HTMLVideoElement).poster)), 'changed URL B loads and captures');
    await wait(() => first.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), 'old source unloaded');
    const second = await video().elementHandle(); assert.ok(second);
    await page.locator('#remove').click();
    await wait(() => second.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), 'unmount releases exact old video');
    await page.locator('#invalid').click();
    await page.locator('.video-thumbnail.is-failed .video-thumbnail-fallback').waitFor();
    assert.equal(await video().count(), 1, 'unreadable thumbnail has a Film fallback');
    await page.locator('#change').click();
    await wait(() => video().evaluate(element => element.getAttribute('src')?.includes('thumbnail=B') === true && Boolean((element as HTMLVideoElement).poster)), 'fallback recovers on new URL');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
