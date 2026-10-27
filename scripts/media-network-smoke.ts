import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSourceFixture } from './v07-source-fixture.js';
import { verifyImportNetwork } from './import-network-smoke.js';

const root = process.cwd();
const fixture = await createSourceFixture(root);
try {
  const network = await verifyImportNetwork(fixture);
  assert.deepEqual(fixture.submissions(), { images: 0, videos: 0, localReferences: 0 }, 'network failures never invoke providers');
  fixture.assertNoLeaks(fixture.store.read());
  const work = path.join(root, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'import-network-report.json'), JSON.stringify({ status: 'PASS', network, paidRequests: 0 }, null, 2));
  console.log('PASS: standalone HTTP duplicate-header, disconnect and 30s upload deadline; zero paid requests.');
} finally {
  await fixture.close();
}
