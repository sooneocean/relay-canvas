import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Artifact, MediaKind } from '../src/shared/types.js';
import { isPublicAddress, validateMediaUrl, type SecurityPolicy } from './security.js';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_QUOTA = 512 * 1024 * 1024;
const DEADLINE_MS = 30_000;

export interface MediaPayload { bytes: Buffer; contentType: string }
export type MediaFetcher = (url: string, policy: SecurityPolicy, signal?: AbortSignal) => Promise<MediaPayload>;
export interface MediaReservation { readonly id: string; readonly bytes: number }
export interface MediaDownloadOptions {
  signal?: AbortSignal;
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  requestImpl?: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  deadlineMs?: number;
}

function mediaError(message: string): Error { return new Error(message); }

export async function downloadMedia(
  urlValue: string,
  policy: SecurityPolicy,
  options: MediaDownloadOptions = {},
): Promise<MediaPayload> {
  const url = new URL(validateMediaUrl(urlValue, policy));
  const signal = options.signal;
  if (signal?.aborted) throw mediaError('Media download aborted');
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS) throw mediaError('Invalid media deadline');
  const startedAt = Date.now();
  let addresses: Array<{ address: string; family: number }>;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  let dnsAbort: (() => void) | undefined;
  try {
    addresses = await Promise.race([
      (options.resolve ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true })))(url.hostname),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(mediaError('Media download timed out')), deadlineMs); }),
      new Promise<never>((_resolve, reject) => { if (signal) { dnsAbort = () => reject(mediaError('Media download aborted')); signal.addEventListener('abort', dnsAbort, { once: true }); } }),
    ]);
  }
  catch { throw mediaError('Media download failed'); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); if (dnsAbort) signal?.removeEventListener('abort', dnsAbort); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw mediaError('Media address is not allowed');
  const remainingMs = deadlineMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw mediaError('Media download timed out');
  const pinned = addresses[0];
  const lookup: LookupFunction = (_hostname, options, callback) => {
    const family = typeof options === 'number' ? options : options.family;
    if (family && family !== 0 && family !== pinned.family) return callback(new Error('Address family mismatch'), '', 0);
    callback(null, pinned.address, pinned.family);
  };
  return await new Promise<MediaPayload>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: ClientRequest;
    const abort = () => { request.destroy(); finish(mediaError('Media download aborted')); };
    const finish = (error?: Error, result?: MediaPayload) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result!);
    };
    request = (options.requestImpl ?? httpsRequest)(url, { method: 'GET', lookup, agent: false, servername: url.hostname }, response => {
      const status = response.statusCode ?? 0;
      const declaredHeader = response.headers['content-length'];
      const declared = declaredHeader === undefined ? undefined : Number(declaredHeader);
      const encoding = response.headers['content-encoding'];
      if ((encoding !== undefined && encoding !== 'identity') || (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_MEDIA_BYTES)) || status < 200 || status >= 300) {
        response.destroy(); return finish(mediaError(status >= 300 && status < 400 ? 'Media redirects are not allowed' : 'Media download failed'));
      }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_MEDIA_BYTES) { response.destroy(); finish(mediaError('Media exceeds file limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (declared !== undefined && total !== declared) return finish(mediaError('Media length mismatch'));
        finish(undefined, { bytes: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? '') });
      });
      response.on('aborted', () => finish(mediaError('Media download failed')));
      response.on('error', () => finish(mediaError('Media download failed')));
    });
    timer = setTimeout(() => { request.destroy(); finish(mediaError('Media download timed out')); }, remainingMs);
    request.on('error', () => finish(mediaError(signal?.aborted ? 'Media download aborted' : 'Media download failed')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    request.end();
  });
}

function detect(bytes: Buffer): { mimeType: string; extension: string; kind: MediaKind } | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return { mimeType: 'image/png', extension: 'png', kind: 'image' };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return { mimeType: 'image/jpeg', extension: 'jpg', kind: 'image' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return { mimeType: 'image/webp', extension: 'webp', kind: 'image' };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const box = bytes.readUInt32BE(0); if (box >= 8 && box <= bytes.length) return { mimeType: 'video/mp4', extension: 'mp4', kind: 'video' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: 'video/webm', extension: 'webm', kind: 'video' };
  return undefined;
}

function parseDataUrl(value: string): MediaPayload {
  if (value.length > Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 128) throw mediaError('Media exceeds file limit');
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) throw mediaError('Unsupported media');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_MEDIA_BYTES) throw mediaError('Media exceeds file limit');
  return { bytes, contentType: match[1].toLowerCase() };
}

export class MediaStore {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly opened = new Set<number>();
  private readonly reservations = new Map<string, number>();
  private readonly rootIdentity: { dev: bigint; ino: bigint };
  private readonly mediaIdentity: { dev: bigint; ino: bigint };
  constructor(
    dataDirectory: string,
    private policy: SecurityPolicy,
    private fetcher: MediaFetcher = (url, policy, signal) => downloadMedia(url, policy, { signal }),
    private projectRoot = process.cwd(),
  ) {
    const rootStat = lstatSync(dataDirectory, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw mediaError('Unsafe media store');
    const canonicalRoot = realpathSync(dataDirectory);
    const canonicalStat = lstatSync(canonicalRoot, { bigint: true });
    if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink() || canonicalStat.dev !== rootStat.dev || canonicalStat.ino !== rootStat.ino) throw mediaError('Unsafe media store');
    this.rootIdentity = { dev: canonicalStat.dev, ino: canonicalStat.ino };
    this.directory = path.join(canonicalRoot, 'media');
    if (existsSync(this.directory)) {
      const existing = lstatSync(this.directory, { bigint: true });
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw mediaError('Unsafe media store');
    } else mkdirSync(this.directory, { mode: 0o700 });
    const mediaStat = lstatSync(this.directory, { bigint: true });
    if (!mediaStat.isDirectory() || mediaStat.isSymbolicLink() || realpathSync(this.directory) !== this.directory) throw mediaError('Unsafe media store');
    this.mediaIdentity = { dev: mediaStat.dev, ino: mediaStat.ino };
    const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(directoryFd, { bigint: true });
      if (opened.dev !== mediaStat.dev || opened.ino !== mediaStat.ino) throw mediaError('Unsafe media store');
      fchmodSync(directoryFd, 0o700);
    } finally { closeSync(directoryFd); }
  }

  private assertDirectories(): void {
    const root = lstatSync(path.dirname(this.directory), { bigint: true });
    const media = lstatSync(this.directory, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.rootIdentity.dev || root.ino !== this.rootIdentity.ino ||
      !media.isDirectory() || media.isSymbolicLink() || media.dev !== this.mediaIdentity.dev || media.ino !== this.mediaIdentity.ino ||
      realpathSync(this.directory) !== this.directory) throw mediaError('Unsafe media store');
  }

  private usage(): number {
    let usage = 0;
    for (const entry of readdirSync(this.directory)) {
      const candidate = path.join(this.directory, entry); const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) throw mediaError('Unsafe media store');
      if (stat.isFile()) usage += stat.size;
    }
    return usage;
  }

  private reservedBytes(): number { return [...this.reservations.values()].reduce((sum, bytes) => sum + bytes, 0); }

  async reserveDerived(maxBytes = MAX_MEDIA_BYTES): Promise<MediaReservation> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES) throw mediaError('Invalid media reservation');
    const operation = this.queue.then(() => {
      this.assertDirectories();
      const available = MAX_MEDIA_QUOTA - this.usage() - this.reservedBytes();
      const bytes = Math.min(maxBytes, available);
      if (bytes < 1) throw mediaError('Media quota exceeded');
      const reservation = { id: randomUUID(), bytes } as const;
      this.reservations.set(reservation.id, bytes);
      return reservation;
    });
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  async releaseReservation(reservation: MediaReservation): Promise<void> {
    const operation = this.queue.then(() => { this.reservations.delete(reservation.id); });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  async commitDerived(
    reservation: MediaReservation,
    fd: number,
    expectedBytes: number,
    commit: (artifact: Artifact) => void,
    isReferenced?: (localId: string) => boolean,
  ): Promise<Artifact> {
    const operation = this.queue.then(() => {
      this.assertDirectories();
      if (this.reservations.get(reservation.id) !== reservation.bytes) throw mediaError('Media reservation expired');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== expectedBytes || stat.size < 1 || stat.size > reservation.bytes || stat.size > MAX_MEDIA_BYTES) throw mediaError('Derived media size mismatch');
      const bytes = readFileSync(fd);
      if (bytes.length !== stat.size) throw mediaError('Derived media size mismatch');
      const detected = detect(bytes);
      if (!detected || detected.mimeType !== 'video/mp4') throw mediaError('Derived media is not MP4');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const artifact: Artifact = { kind: 'video', url: `/api/media/${hash}`, localId: hash, localUrl: `/api/media/${hash}`, bytes: bytes.length, sha256: hash, mimeType: 'video/mp4' };
      const destination = path.join(this.directory, `${hash}.mp4`);
      let created = false;
      try {
        if (existsSync(destination)) {
          const existing = lstatSync(destination);
          if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 || existing.size !== bytes.length) throw mediaError('Unsafe media store');
          const existingFd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { if (createHash('sha256').update(readFileSync(existingFd)).digest('hex') !== hash) throw mediaError('Unsafe media store'); }
          finally { closeSync(existingFd); }
        } else {
          if (this.usage() + bytes.length > MAX_MEDIA_QUOTA) throw mediaError('Media quota exceeded');
          const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
          try {
            const output = openSync(temp, 'wx', 0o600);
            try { writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
            this.assertDirectories(); renameSync(temp, destination); created = true;
            const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
          } finally { if (existsSync(temp)) unlinkSync(temp); }
        }
        commit(artifact);
        return artifact;
      } catch (error) {
        let referenced = true;
        try { referenced = isReferenced?.(hash) ?? false; } catch { referenced = true; }
        if (created && !referenced && existsSync(destination)) unlinkSync(destination);
        throw error;
      } finally { this.reservations.delete(reservation.id); }
    });
    this.queue = operation.catch(() => { this.reservations.delete(reservation.id); return undefined; });
    return await operation;
  }

  async save(source: Artifact | (() => Artifact), commit: (artifact: Artifact) => void, options: { signal?: AbortSignal; isReferenced?: (localId: string) => boolean } = {}): Promise<Artifact> {
    if (options.signal?.aborted) throw mediaError('Media save aborted');
    const operation = this.queue.then(() => this.saveSerialized(typeof source === 'function' ? source() : source, commit, options));
    this.queue = operation.catch(() => undefined);
    return await operation;
  }

  private async saveSerialized(source: Artifact, commit: (artifact: Artifact) => void, options: { signal?: AbortSignal; isReferenced?: (localId: string) => boolean }): Promise<Artifact> {
    this.assertDirectories();
    if (options.signal?.aborted) throw mediaError('Media save aborted');
    if (source.localId && source.localUrl && source.sha256 && source.bytes !== undefined && source.mimeType) return source;
    let payload: MediaPayload;
    let trustedSvg = false;
    if (source.demo && source.kind === 'image' && source.url.startsWith('data:image/svg+xml;charset=utf-8,')) {
      const text = decodeURIComponent(source.url.slice('data:image/svg+xml;charset=utf-8,'.length));
      payload = { bytes: Buffer.from(text), contentType: 'image/svg+xml' }; trustedSvg = true;
    } else if (source.demo && source.kind === 'video' && source.url === '/demo-motion.mp4') {
      const packaged = path.join(this.projectRoot, 'dist', 'demo-motion.mp4');
      const development = path.join(this.projectRoot, 'public', 'demo-motion.mp4');
      const bundled = existsSync(packaged) ? packaged : development;
      if (!existsSync(bundled)) throw mediaError('Bundled Demo media is unavailable');
      payload = { bytes: readFileSync(bundled), contentType: 'video/mp4' };
    } else if (source.url.startsWith('data:')) payload = parseDataUrl(source.url);
    else payload = await this.fetcher(source.url, this.policy, options.signal);
    if (options.signal?.aborted) throw mediaError('Media save aborted');
    this.assertDirectories();
    if (payload.bytes.length === 0 || payload.bytes.length > MAX_MEDIA_BYTES) throw mediaError('Media exceeds file limit');
    const detected = trustedSvg ? { mimeType: 'image/svg+xml', extension: 'svg', kind: 'image' as const } : detect(payload.bytes);
    if (!detected || detected.kind !== source.kind) throw mediaError('Unsupported media signature');
    const declared = payload.contentType.split(';', 1)[0].trim().toLowerCase();
    if (declared !== detected.mimeType) throw mediaError('Media type mismatch');
    const hash = createHash('sha256').update(payload.bytes).digest('hex');
    const artifact: Artifact = { ...source, localId: hash, localUrl: `/api/media/${hash}`, bytes: payload.bytes.length, sha256: hash, mimeType: detected.mimeType };
    const destination = path.join(this.directory, `${hash}.${detected.extension}`);
    let created = false;
    if (existsSync(destination)) {
      const existing = lstatSync(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 || existing.size !== payload.bytes.length) throw mediaError('Unsafe media store');
      const existingFd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(existingFd);
        this.assertDirectories();
        if (!opened.isFile() || opened.dev !== existing.dev || opened.ino !== existing.ino || createHash('sha256').update(readFileSync(existingFd)).digest('hex') !== hash) throw mediaError('Unsafe media store');
      } finally { closeSync(existingFd); }
    } else {
      this.assertDirectories();
      const usage = this.usage();
      if (usage + this.reservedBytes() + payload.bytes.length > MAX_MEDIA_QUOTA) throw mediaError('Media quota exceeded');
      const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
      try {
        this.assertDirectories();
        const fd = openSync(temp, 'wx', 0o600);
        try { writeFileSync(fd, payload.bytes); fsyncSync(fd); } finally { closeSync(fd); }
        this.assertDirectories();
        renameSync(temp, destination); created = true;
        const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      } finally { if (existsSync(temp)) unlinkSync(temp); }
    }
    try { commit(artifact); }
    catch (error) {
      let referenced = true;
      try { referenced = options.isReferenced?.(hash) ?? false; } catch { referenced = true; }
      if (created && !referenced && existsSync(destination)) {
        this.assertDirectories();
        const current = lstatSync(destination);
        if (current.isFile() && !current.isSymbolicLink()) unlinkSync(destination);
        const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      throw error;
    }
    return artifact;
  }

  fileFor(artifact: Artifact): { file: string; fd: number; size: number } {
    this.assertDirectories();
    if (!artifact.localId || artifact.localId !== artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.localId) || !artifact.mimeType) throw mediaError('Unknown media');
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm' } as Record<string, string>)[artifact.mimeType];
    if (!extension) throw mediaError('Unknown media');
    const file = path.join(this.directory, `${artifact.localId}.${extension}`);
    if (!file.startsWith(`${this.directory}${path.sep}`) || !existsSync(file)) throw mediaError('Unknown media');
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw mediaError('Unknown media');
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      this.assertDirectories();
      if (!opened.isFile() || opened.size !== artifact.bytes) throw mediaError('Unknown media');
      this.opened.add(fd);
      return { file, fd, size: opened.size };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      throw error;
    }
  }
  releaseFile(fd: number): void {
    if (!this.opened.delete(fd)) return;
    try { closeSync(fd); } catch { /* already closed by the runtime */ }
  }
  openFileCount(): number { return this.opened.size; }
}
