import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact, EditorCapabilities, MediaInfo, Timeline } from '../src/shared/types.js';
import { parseMediaInfo } from '../src/shared/schema.js';
import { MediaStore, MAX_MEDIA_BYTES, type MediaReservation } from './media.js';

const MAX_EPHEMERAL = 192 * 1024 * 1024;
const MAX_SEGMENTS = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const KNOWN = /^(?:source|segment)-\d{3}\.(?:mp4|webm)$|^segments\.txt$|^output\.mp4$/;

interface Binary { path: string; dev: bigint; ino: bigint }
interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; truncated: boolean }

function inside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

export function resolveExecutable(name: string, workspaceRoot: string, pathValue = process.env.PATH ?? ''): Binary | undefined {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      const canonical = realpathSync(candidate);
      if (inside(canonicalWorkspace, canonical)) continue;
      const stat = lstatSync(canonical, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111n) === 0n) continue;
      return { path: canonical, dev: stat.dev, ino: stat.ino };
    } catch { /* continue searching */ }
  }
  return undefined;
}

function validateExecutable(binary: Binary): void {
  const stat = lstatSync(binary.path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== binary.dev || stat.ino !== binary.ino || (stat.mode & 0o111n) === 0n) throw new Error('Editor executable changed');
}

function sanitizedEnv(): Record<string, string> {
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent' };
}

function runSupervised(binary: Binary, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): { child: ChildProcess; result: Promise<CommandResult> } {
  validateExecutable(binary);
  const compiledSupervisor = fileURLToPath(new URL('./editor-supervisor.js', import.meta.url));
  const supervisorPath = existsSync(compiledSupervisor) ? compiledSupervisor : fileURLToPath(new URL('./editor-supervisor.ts', import.meta.url));
  const supervisor = fork(supervisorPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: process.execArgv });
  let abort: (() => void) | undefined;
  const result = new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: CommandResult) => {
      if (settled) return; settled = true;
      if (abort) signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    abort = () => { if (supervisor.connected) supervisor.send({ type: 'cancel' }); };
    signal?.addEventListener('abort', abort, { once: true });
    supervisor.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'result') return;
      const value = message as CommandResult & { type: 'result' };
      finish(undefined, { code: value.code, signal: value.signal, stdout: value.stdout, stderr: value.stderr, truncated: value.truncated });
    });
    supervisor.once('error', () => finish(new Error('Editor process failed')));
    supervisor.once('exit', () => { setImmediate(() => finish(new Error('Editor process failed'))); });
    supervisor.send({ type: 'start', executable: binary.path, args, cwd, env: sanitizedEnv(), timeoutMs, outputLimit: OUTPUT_LIMIT });
    if (signal?.aborted) abort();
  });
  return { child: supervisor, result };
}

class EphemeralWorkspace {
  readonly root: string;
  private readonly identity: { dev: bigint; ino: bigint };
  private reserved = 0;
  constructor(directory: string) {
    this.root = path.join(directory, 'editor-jobs');
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const stat = lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.root) !== this.root) throw new Error('Unsafe editor workspace');
    this.identity = { dev: stat.dev, ino: stat.ino };
  }
  private assertRoot(): void {
    const stat = lstatSync(this.root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino || realpathSync(this.root) !== this.root) throw new Error('Unsafe editor workspace');
  }
  private usage(): number {
    this.assertRoot(); let bytes = 0;
    for (const entry of readdirSync(this.root)) {
      const job = path.join(this.root, entry), stat = lstatSync(job);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { bytes += stat.size; continue; }
      for (const child of readdirSync(job)) { const file = lstatSync(path.join(job, child)); bytes += file.size; }
    }
    return bytes;
  }
  reserve(bytes: number): () => void {
    if (this.usage() + this.reserved + bytes > MAX_EPHEMERAL) throw new Error('Editor temporary storage limit reached');
    this.reserved += bytes; let active = true;
    return () => { if (active) { active = false; this.reserved -= bytes; } };
  }
  create(): { directory: string; dev: bigint; ino: bigint } {
    this.assertRoot();
    const directory = path.join(this.root, randomUUID()); mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory, { bigint: true });
    return { directory, dev: stat.dev, ino: stat.ino };
  }
  check(job: { directory: string; dev: bigint; ino: bigint }): number {
    this.assertRoot(); const stat = lstatSync(job.directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== job.dev || stat.ino !== job.ino || path.dirname(job.directory) !== this.root) throw new Error('Unsafe editor job');
    let bytes = 0;
    for (const name of readdirSync(job.directory)) { if (!KNOWN.test(name)) throw new Error('Unknown editor remnant'); const stat = lstatSync(path.join(job.directory, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe editor file'); bytes += stat.size; }
    return bytes;
  }
  cleanup(job: { directory: string; dev: bigint; ino: bigint }): void {
    try {
      this.check(job);
      for (const name of readdirSync(job.directory)) if (KNOWN.test(name)) unlinkSync(path.join(job.directory, name));
      rmdirSync(job.directory);
    } catch { /* retain unexpected remnants for quarantine and quota accounting */ }
  }
}

function copyVerified(media: MediaStore, artifact: Artifact, destination: string): void {
  const located = media.fileFor(artifact);
  let output: number | undefined;
  try {
    const before = fstatSync(located.fd, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(artifact.bytes ?? -1)) throw new Error('Source media changed');
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(output, 0o600);
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
    while (true) {
      const count = readSync(located.fd, buffer, 0, buffer.length, total);
      if (!count) break;
      total += count; if (total > MAX_MEDIA_BYTES || total > (artifact.bytes ?? -1)) throw new Error('Source media changed');
      hash.update(buffer.subarray(0, count));
      let offset = 0; while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
    }
    fsyncSync(output);
    const after = fstatSync(located.fd, { bigint: true }), copied = fstatSync(output, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        total !== artifact.bytes || copied.size !== BigInt(total) || hash.digest('hex') !== artifact.sha256) throw new Error('Source media changed');
  } finally { if (output !== undefined) closeSync(output); media.releaseFile(located.fd); }
}

function inputArgs(file: string, mimeType: string): string[] {
  if (mimeType === 'video/mp4') return ['-f', 'mov', '-protocol_whitelist', 'file', '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2', '-i', file];
  if (mimeType === 'video/webm') return ['-f', 'matroska', '-protocol_whitelist', 'file', '-threads', '2', '-i', file];
  throw new Error('Unsupported editor source');
}

export class EditorRuntime {
  private readonly ffmpeg?: Binary;
  private readonly ffprobe?: Binary;
  private readonly workspace: EphemeralWorkspace;
  private capability?: Promise<EditorCapabilities>;
  private probes = 0;
  constructor(private readonly directory: string, private readonly media: MediaStore, workspaceRoot = process.cwd(), pathValue = process.env.PATH ?? '') {
    this.workspace = new EphemeralWorkspace(directory);
    this.ffmpeg = resolveExecutable('ffmpeg', workspaceRoot, pathValue);
    this.ffprobe = resolveExecutable('ffprobe', workspaceRoot, pathValue);
  }
  capabilities(): Promise<EditorCapabilities> {
    this.capability ??= this.detectCapabilities(); return this.capability;
  }
  private async detectCapabilities(): Promise<EditorCapabilities> {
    let ffmpeg = false, ffprobe = false;
    try {
      if (this.ffmpeg) {
        const version = await runSupervised(this.ffmpeg, ['-hide_banner', '-version'], this.directory, 10_000).result;
        const encoders = await runSupervised(this.ffmpeg, ['-hide_banner', '-encoders'], this.directory, 10_000).result;
        const options = await runSupervised(this.ffmpeg, ['-hide_banner', '-h', 'demuxer=mov'], this.directory, 10_000).result;
        const major = /ffmpeg version\s+(?:n)?(\d+)/i.exec(version.stdout)?.[1];
        ffmpeg = version.code === 0 && Number(major) >= 6 && encoders.code === 0 && /\blibx264\b/.test(encoders.stdout) && /\bAAC\b/i.test(encoders.stdout) && options.code === 0 && /enable_drefs/.test(options.stdout + options.stderr) && /use_absolute_path/.test(options.stdout + options.stderr);
      }
    } catch { ffmpeg = false; }
    try {
      if (this.ffprobe) {
        const version = await runSupervised(this.ffprobe, ['-hide_banner', '-version'], this.directory, 10_000).result;
        const major = /ffprobe version\s+(?:n)?(\d+)/i.exec(version.stdout)?.[1];
        ffprobe = version.code === 0 && Number(major) >= 6;
      }
    } catch { ffprobe = false; }
    return { available: ffmpeg && ffprobe, ffmpeg, ffprobe, formats: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } }, fps: 24, limits: { maxClips: 12, maxClipSeconds: 60, maxTimelineSeconds: 180, maxSourceBytes: MAX_MEDIA_BYTES } };
  }
  async probe(artifact: Artifact): Promise<MediaInfo> {
    if (!this.ffprobe) throw new Error('Editor tools unavailable');
    if (this.probes >= 2) throw new Error('Editor probe busy');
    const release = this.workspace.reserve(MAX_MEDIA_BYTES); let job: ReturnType<EphemeralWorkspace['create']> | undefined; this.probes++;
    const ext = artifact.mimeType === 'video/mp4' ? 'mp4' : artifact.mimeType === 'video/webm' ? 'webm' : '';
    try {
      job = this.workspace.create();
      const source = path.join(job.directory, `source-000.${ext}`);
      copyVerified(this.media, artifact, source);
      const capabilities = await this.capabilities();
      if (!capabilities.ffprobe) throw new Error('Editor tools unavailable');
      const args = ['-v', 'error', '-max_alloc', String(MAX_MEDIA_BYTES), '-analyzeduration', '10000000', '-probesize', String(8 * 1024 * 1024), ...inputArgs(source, artifact.mimeType!), '-show_entries', 'format=duration,format_name:stream=codec_type,width,height', '-of', 'json'];
      const result = await runSupervised(this.ffprobe, args, job.directory, 10_000).result;
      if (result.code !== 0 || result.truncated) throw new Error('Media probe failed');
      const parsed = JSON.parse(result.stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
      const video = parsed.streams?.find(stream => stream.codec_type === 'video');
      if (!video || !Number.isInteger(video.width) || !Number.isInteger(video.height)) throw new Error('Media probe failed');
      if (artifact.mimeType === 'video/mp4' && !String(parsed.format?.format_name).split(',').includes('mov')) throw new Error('Media probe failed');
      if (artifact.mimeType === 'video/webm' && !/matroska|webm/.test(String(parsed.format?.format_name))) throw new Error('Media probe failed');
      return parseMediaInfo({ duration: Number(parsed.format?.duration), width: video.width, height: video.height, hasAudio: parsed.streams?.some(stream => stream.codec_type === 'audio') ?? false });
    } finally { this.probes--; if (job) this.workspace.cleanup(job); release(); }
  }
  async export(
    timeline: Timeline,
    commit: (artifact: Artifact) => void,
    isReferenced: (localId: string) => boolean,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    if (!this.ffmpeg || !this.ffprobe) throw new Error('Editor tools unavailable');
    if (!timeline.clips.length) throw new Error('Timeline is empty');
    const release = this.workspace.reserve(MAX_EPHEMERAL); let reservation: MediaReservation | undefined; let job: ReturnType<EphemeralWorkspace['create']> | undefined;
    let committed = false, segmentBytes = 0;
    const startedAt = Date.now();
    const remaining = () => {
      const value = 180_000 - (Date.now() - startedAt);
      if (value < 1) throw new Error('Export deadline exceeded');
      return value;
    };
    try {
      reservation = await this.media.reserveDerived(MAX_MEDIA_BYTES);
      job = this.workspace.create();
      for (let index = 0; index < timeline.clips.length; index++) {
        if (signal?.aborted) throw new Error('Export cancelled');
        const clip = timeline.clips[index], tag = String(index).padStart(3, '0');
        const ext = clip.artifact.mimeType === 'video/mp4' ? 'mp4' : 'webm';
        const sourceName = `source-${tag}.${ext}`, segmentName = `segment-${tag}.mp4`;
        const source = path.join(job.directory, sourceName), segment = path.join(job.directory, segmentName);
        copyVerified(this.media, clip.artifact, source);
        const capabilities = await this.capabilities();
        if (!capabilities.available) throw new Error('Editor tools unavailable');
        const duration = clip.outSeconds - clip.inSeconds, dimensions = capabilities.formats[timeline.format];
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', String(MAX_MEDIA_BYTES), '-filter_threads', '2', '-ss', clip.inSeconds.toFixed(6), '-t', duration.toFixed(6), ...inputArgs(sourceName, clip.artifact.mimeType!)];
        if (!clip.media.hasAudio) args.push('-f', 'lavfi', '-t', duration.toFixed(6), '-threads', '2', '-i', 'anullsrc=r=48000:cl=stereo');
        args.push('-map', '0:v:0', '-map', clip.media.hasAudio ? '0:a:0' : '1:a:0',
          '-vf', `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:black,fps=24,setsar=1,format=yuv420p`,
          '-af', `aresample=48000,apad,atrim=duration=${duration.toFixed(6)}`,
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-threads', '2', '-shortest', '-movflags', '+faststart',
          '-fs', String(MAX_SEGMENTS - segmentBytes + 1), '-y', segmentName);
        const result = await runSupervised(this.ffmpeg, args, job.directory, remaining(), signal).result;
        unlinkSync(source);
        if (result.code !== 0 || result.truncated) throw new Error('Export process failed');
        const stat = lstatSync(segment); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error('Export process failed');
        segmentBytes += stat.size; if (segmentBytes > MAX_SEGMENTS || this.workspace.check(job) > MAX_EPHEMERAL) throw new Error('Editor temporary storage limit reached');
      }
      const manifest = timeline.clips.map((_clip, index) => `file 'segment-${String(index).padStart(3, '0')}.mp4'\n`).join('');
      const manifestFile = path.join(job.directory, 'segments.txt'); writeFileSync(manifestFile, manifest, { flag: 'wx', mode: 0o600 });
      const concat = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', String(MAX_MEDIA_BYTES), '-filter_threads', '2', '-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file', '-threads', '2', '-i', 'segments.txt', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-threads', '2', '-movflags', '+faststart', '-fs', String(reservation.bytes + 1), '-y', 'output.mp4'];
      const result = await runSupervised(this.ffmpeg, concat, job.directory, remaining(), signal).result;
      if (result.code !== 0 || result.truncated) throw new Error('Export process failed');
      const output = path.join(job.directory, 'output.mp4'), stat = lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > reservation.bytes || this.workspace.check(job) > MAX_EPHEMERAL) throw new Error('Export output limit reached');
      const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const artifact = await this.media.commitDerived(reservation, fd, stat.size, commit, isReferenced);
        committed = true; return artifact;
      } finally { closeSync(fd); }
    } finally {
      if (!committed && reservation) await this.media.releaseReservation(reservation);
      if (job) this.workspace.cleanup(job); release();
    }
  }
}
