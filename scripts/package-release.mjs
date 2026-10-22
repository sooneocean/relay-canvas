import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const releaseDir = resolve(root, 'release');
const archiveName = `${pkg.name}-${pkg.version}.tar.gz`;
const archive = resolve(releaseDir, archiveName);
const shaFile = `${archive}.sha256`;

const required = ['dist', 'build/server', 'build/src/shared', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'docs', '.env.example'];
const missing = required.filter((entry) => !existsSync(resolve(root, entry)));
if (missing.length) {
  console.error(`release prerequisites missing: ${missing.join(', ')}`);
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
rmSync(archive, { force: true });
rmSync(shaFile, { force: true });

const tar = spawnSync('tar', ['-czf', archive, '--', ...required], { cwd: root, stdio: 'inherit' });
if (tar.error) throw tar.error;
if (tar.status !== 0) process.exit(tar.status ?? 1);

const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
const { writeFileSync } = await import('node:fs');
writeFileSync(shaFile, `${digest}  ${archiveName}\n`, { mode: 0o644 });
console.log(`created ${archive}`);
console.log(`sha256 ${digest}`);
