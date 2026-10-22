import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
export class Store {
  private data: StoreData;
  readonly file: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'workspace.json');
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 80 * 1024 * 1024) throw new Error('Workspace exceeds storage limit.');
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as StoreData;
      if (value.schemaVersion !== 1 || !Array.isArray(value.boards) || !Array.isArray(value.runs) || value.boards.length > 20 || value.runs.length > 200) throw new Error('Unsupported or corrupt workspace; original file preserved.');
      value.boards = value.boards.map(parseBoard); value.providers = parseProviders(value.providers);
      this.data = value;
      const active = ['pending', 'submitting', 'running'];
      for (const run of this.data.runs) if (active.includes(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = '服務曾中斷；未重新提交。遠端工作可能仍執行，請依 remoteId 查詢。';
        for (const result of Object.values(run.results)) if (active.includes(result.status)) result.status = 'interrupted';
      }
      atomicWrite(this.file, this.data);
    } else {
      this.data = { schemaVersion: 1, boards: [starterBoard()], providers: structuredClone(providers), runs: [] };
      atomicWrite(this.file, this.data);
    }
  }
  read(): StoreData { return structuredClone(this.data); }
  transaction<T>(change: (next: StoreData) => T): T {
    const next = structuredClone(this.data), result = change(next);
    atomicWrite(this.file, next); this.data = next;
    return structuredClone(result);
  }
}
