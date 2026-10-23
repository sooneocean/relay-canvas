import { spawn, type ChildProcess } from 'node:child_process';

interface StartMessage {
  type: 'start';
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputLimit: number;
}

let child: ChildProcess | undefined;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), truncated = false;

function append(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (current.length >= limit) { truncated = true; return current; }
  if (current.length + chunk.length > limit) truncated = true;
  return Buffer.concat([current, chunk.subarray(0, Math.max(0, limit - current.length))]);
}

function signalGroup(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already closed */ } }
}

function stop(): void {
  if (!child || stopping) return;
  stopping = true;
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 1_000).unref();
}

process.once('disconnect', stop);
process.on('message', (message: StartMessage | { type: 'cancel' }) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'cancel') { stop(); return; }
  if (child || !Array.isArray(message.args) || !Number.isInteger(message.timeoutMs) || message.timeoutMs < 1 || message.timeoutMs > 180_000 ||
      !Number.isInteger(message.outputLimit) || message.outputLimit < 1 || message.outputLimit > 1024 * 1024) process.exit(2);
  child = spawn(message.executable, message.args, {
    cwd: message.cwd,
    env: message.env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, message.outputLimit); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, message.outputLimit); });
  child.once('error', () => { /* close or exit reports the durable result */ });
  child.once('close', (code, signal) => {
    if (timer) clearTimeout(timer);
    const exit = () => process.exit(code === 0 && !stopping ? 0 : 1);
    if (process.connected) process.send?.({ type: 'result', code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated }, exit);
    else exit();
  });
  timer = setTimeout(stop, message.timeoutMs);
  timer.unref();
});
