import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providers, starterBoard } from '../src/shared/defaults.js';
import type { StoreData } from '../src/shared/types.js';
import { parseBoard, parseProviders } from '../src/shared/schema.js';

export function atomicWrite(file: string, value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 80 * 1024 * 1024) throw new Error('Workspace storage limit reached.');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function atomicBackup(file: string, bytes: Buffer) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(path.dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
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
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 80 * 1024 * 1024) throw new Error('Workspace exceeds storage limit.');
      const original = readFileSync(this.file);
      const value = JSON.parse(original.toString('utf8')) as StoreData;
      if (value.schemaVersion !== 1 || !Array.isArray(value.boards) || !Array.isArray(value.runs) || value.boards.length > 20 || value.runs.length > 200) throw new Error('Unsupported or corrupt workspace; original file preserved.');
      value.boards = value.boards.map(parseBoard); value.providers = parseProviders(value.providers);
      validateArtifactMetadata(value);
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
      this.writer(this.file, this.data);
    } else {
      this.data = { schemaVersion: 1, boards: [starterBoard()], providers: structuredClone(providers), runs: [] };
      this.writer(this.file, this.data);
      atomicBackup(versionMarker, Buffer.from('0.3\n'));
    }
  }
  read(): StoreData { return structuredClone(this.data); }
  private readPersisted(): StoreData {
    const value = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
    if (value.schemaVersion !== 1 || !Array.isArray(value.boards) || !Array.isArray(value.providers) || !Array.isArray(value.runs) || value.boards.length > 20 || value.runs.length > 200) throw new Error('Unsupported or corrupt workspace; original file preserved.');
    value.boards = value.boards.map(parseBoard); value.providers = parseProviders(value.providers); validateArtifactMetadata(value);
    return value;
  }
  transaction<T>(change: (next: StoreData) => T): T {
    const next = structuredClone(this.data), result = change(next);
    try { this.writer(this.file, next); this.data = next; }
    catch (error) {
      try { this.data = this.readPersisted(); } catch { /* preserve last known in-memory state when disk cannot be verified */ }
      throw error;
    }
    return structuredClone(result);
  }
  artifactReferenced(localId: string): boolean {
    const persisted = this.readPersisted();
    this.data = persisted;
    return persisted.runs.some(run => Object.values(run.results).some(result => result.artifacts.some(artifact => artifact.localId === localId && artifact.sha256 === localId)));
  }
}
