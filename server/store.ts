import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { providers, starterBoard } from '../src/shared/defaults.js';
import type { StoreData } from '../src/shared/types.js';
import { parseStoreData } from '../src/shared/schema.js';

export function atomicWrite(file: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 80 * 1024 * 1024) throw new Error('Workspace storage limit reached.');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function atomicBackup(file: string, bytes: Buffer) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { fchmodSync(fd, 0o600); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function strictFileBytes(file: string): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) throw new Error('Unsafe workspace upgrade artifact.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || (opened.mode & 0o777) !== 0o600) throw new Error('Unsafe workspace upgrade artifact.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function ensureV07Upgrade(directory: string, original: Buffer): void {
  const backup = path.join(directory, 'workspace.pre-v0.7.json');
  const marker = path.join(directory, '.workspace-v0.7');
  const sourceSha256 = createHash('sha256').update(original).digest('hex');
  const backupExists = existsSync(backup), markerExists = existsSync(marker);
  if (backupExists !== markerExists) {
    if (backupExists && !markerExists) {
      const bytes = strictFileBytes(backup);
      if (!bytes.equals(original)) throw new Error('Workspace v0.7 backup does not match the original workspace.');
      atomicBackup(marker, Buffer.from(JSON.stringify({ version: '0.7', sourceSha256 })));
      strictFileBytes(marker);
      return;
    }
    throw new Error('Incomplete workspace v0.7 upgrade artifacts.');
  }
  if (!backupExists) {
    atomicBackup(backup, original);
    atomicBackup(marker, Buffer.from(JSON.stringify({ version: '0.7', sourceSha256 })));
    if (!strictFileBytes(backup).equals(original)) throw new Error('Workspace v0.7 backup verification failed.');
    strictFileBytes(marker);
    return;
  }
  const backupBytes = strictFileBytes(backup);
  let value: unknown;
  const markerBytes = strictFileBytes(marker);
  try { value = JSON.parse(markerBytes.toString('utf8')); } catch { throw new Error('Invalid workspace v0.7 marker.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || (value as { version?: unknown }).version !== '0.7' || (value as { sourceSha256?: unknown }).sourceSha256 !== createHash('sha256').update(backupBytes).digest('hex')) {
    throw new Error('Invalid workspace v0.7 marker.');
  }
}

function validateArtifactMetadata(value: StoreData): void {
  for (const run of value.runs) for (const result of Object.values(run.results ?? {})) for (const artifact of result.artifacts ?? []) {
    const local = [artifact.localId, artifact.localUrl, artifact.bytes, artifact.sha256];
    const count = local.filter(entry => entry !== undefined).length;
    if (count !== 0 && count !== local.length) throw new Error('Unsupported or corrupt workspace; original file preserved.');
    if (count && (
      typeof artifact.localId !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.localId) ||
      artifact.sha256 !== artifact.localId || artifact.localUrl !== `/api/media/${artifact.localId}` ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes! < 1 || artifact.bytes! > 64 * 1024 * 1024 ||
      typeof artifact.mimeType !== 'string'
    )) throw new Error('Unsupported or corrupt workspace; original file preserved.');
  }
  for (const job of value.exports ?? []) if (job.artifact) {
    const artifact = job.artifact;
    if (!artifact.localId || artifact.localId !== artifact.sha256 || artifact.localUrl !== `/api/media/${artifact.localId}` || artifact.mimeType !== 'video/mp4' || !Number.isSafeInteger(artifact.bytes)) {
      throw new Error('Unsupported or corrupt workspace; original file preserved.');
    }
  }
}
export class Store {
  private data: StoreData;
  readonly file: string;
  readonly directory: string;
  private readonly writer: typeof atomicWrite;
  constructor(directory: string, options: { write?: typeof atomicWrite } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe workspace directory.');
    this.directory = realpathSync(directory);
    this.writer = options.write ?? atomicWrite;
    this.file = path.join(this.directory, 'workspace.json');
    const versionMarker = path.join(this.directory, '.workspace-v0.3');
    const versionMarker04 = path.join(this.directory, '.workspace-v0.4');
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 80 * 1024 * 1024) throw new Error('Workspace exceeds storage limit.');
      const workspaceMetadata = lstatSync(this.file);
      if (!workspaceMetadata.isFile() || workspaceMetadata.isSymbolicLink()) throw new Error('Unsafe workspace file.');
      const original = strictFileBytes(this.file);
      const value = JSON.parse(original.toString('utf8')) as StoreData;
      if (value.schemaVersion !== 1 || !Array.isArray(value.boards) || !Array.isArray(value.runs) || value.boards.length > 20 || value.runs.length > 200) throw new Error('Unsupported or corrupt workspace; original file preserved.');
      const parsed = parseStoreData(value);
      value.boards = parsed.boards; value.providers = parsed.providers; value.runs = parsed.runs; value.timelines = parsed.timelines; value.exports = parsed.exports; value.localAssets = parsed.localAssets;
      validateArtifactMetadata(value);
      ensureV07Upgrade(this.directory, original);
      const v04Backup = path.join(directory, 'workspace.pre-v0.4.json');
      if (!existsSync(versionMarker04) && !existsSync(v04Backup)) atomicBackup(v04Backup, original);
      if (!existsSync(versionMarker04)) atomicBackup(versionMarker04, Buffer.from('0.4\n'));
      const backup = path.join(directory, 'workspace.pre-v0.3.json');
      if (!existsSync(versionMarker) && !existsSync(backup)) atomicBackup(backup, original);
      if (!existsSync(versionMarker)) atomicBackup(versionMarker, Buffer.from('0.3\n'));
      this.data = value;
      const active = ['pending', 'submitting', 'running'];
      for (const run of this.data.runs) if (active.includes(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = '服務曾中斷；未重新提交。遠端工作可能仍執行，請依 remoteId 查詢。';
        for (const result of Object.values(run.results)) if (active.includes(result.status)) result.status = 'interrupted';
      }
      for (const job of this.data.exports ?? []) if (job.status === 'pending' || job.status === 'running') {
        job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); job.error = '匯出因服務中斷而停止；不會自動重試。';
      }
      this.writeValidated(this.data);
    } else {
      this.data = { schemaVersion: 1, boards: [starterBoard()], providers: structuredClone(providers), runs: [] };
      this.writeValidated(this.data);
      ensureV07Upgrade(this.directory, strictFileBytes(this.file));
      atomicBackup(versionMarker, Buffer.from('0.3\n'));
      atomicBackup(versionMarker04, Buffer.from('0.4\n'));
    }
  }
  read(): StoreData { return structuredClone(this.data); }
  private readPersisted(): StoreData {
    const value = JSON.parse(strictFileBytes(this.file).toString('utf8')) as StoreData;
    if (value.schemaVersion !== 1 || !Array.isArray(value.boards) || !Array.isArray(value.providers) || !Array.isArray(value.runs) || value.boards.length > 20 || value.runs.length > 200) throw new Error('Unsupported or corrupt workspace; original file preserved.');
    const parsed = parseStoreData(value);
    validateArtifactMetadata(parsed);
    return parsed;
  }
  private writeValidated(value: StoreData): void {
    const parsed = parseStoreData(value);
    validateArtifactMetadata(parsed);
    const text = JSON.stringify(parsed);
    if (Buffer.byteLength(text) > 80 * 1024 * 1024) throw new Error('Workspace storage limit reached.');
    this.writer(this.file, parsed);
  }
  transaction<T>(change: (next: StoreData) => T): T {
    const next = structuredClone(this.data), result = change(next);
    const beforeAssets = JSON.stringify(this.data.localAssets ?? []);
    const afterAssets = next.localAssets ?? [];
    const existingPrefix = JSON.stringify(afterAssets.slice(0, this.data.localAssets?.length ?? 0));
    if (existingPrefix !== beforeAssets) throw new Error('Local asset registry is immutable.');
    try { this.writeValidated(next); this.data = next; }
    catch (error) {
      try { this.data = this.readPersisted(); } catch { /* preserve last known in-memory state when disk cannot be verified */ }
      throw error;
    }
    return structuredClone(result);
  }
  artifactReferenced(localId: string): boolean {
    const persisted = this.readPersisted();
    this.data = persisted;
    return persisted.runs.some(run => Object.values(run.results).some(result => result.artifacts.some(artifact => artifact.localId === localId && artifact.sha256 === localId))) ||
      (persisted.exports ?? []).some(job => job.artifact?.localId === localId && job.artifact.sha256 === localId) ||
      (persisted.localAssets ?? []).some(asset => asset.artifact.localId === localId && asset.artifact.sha256 === localId);
  }
}
