import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, atomicWrite } from './store.js';
import { CanvasService } from './service.js';
import { createApp, serveProduction } from './app.js';

const root = process.cwd();
const requestedDirectory = path.resolve(process.env.RELAY_DATA_DIR ?? path.join(root, '.relay-canvas'));
const port = Number(process.env.RELAY_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RELAY_PORT must be between 1024 and 65535.');
const origin = `http://127.0.0.1:${port}`;
const dev = process.argv.includes('--dev');
mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 });
const directoryStat = lstatSync(requestedDirectory);
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('RELAY_DATA_DIR must be a real directory.');
const directory = realpathSync(requestedDirectory);
const lockFile = path.join(directory, 'server.lock'), lock = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
if (existsSync(lockFile)) {
  const old = readFileSync(lockFile, 'utf8');
  let alive = true;
  try { const pid = JSON.parse(old).pid; if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid workspace lock'); process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error('This workspace already has a server. Use its existing session.');
  if (readFileSync(lockFile, 'utf8') !== old) throw new Error('Workspace lock changed; retry later.');
  unlinkSync(lockFile);
}
writeFileSync(lockFile, lock, { flag: 'wx', mode: 0o600 });
let ownedSession: string | undefined;
function releaseLock() {
  if (ownedSession && existsSync(path.join(directory, 'session.json')) && readFileSync(path.join(directory, 'session.json'), 'utf8') === ownedSession) unlinkSync(path.join(directory, 'session.json'));
  if (existsSync(lockFile) && readFileSync(lockFile, 'utf8') === lock) unlinkSync(lockFile);
}
process.on('exit', releaseLock);
try {
  const store = new Store(directory), service = new CanvasService(store);
  const { app, token } = createApp(service, origin, undefined, dev);
  let closeDev: undefined | (() => Promise<void>);
  if (dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares); closeDev = () => vite.close();
  } else serveProduction(app, root);
  const server = app.listen(port, '127.0.0.1', () => {
    const session = { origin, token, pid: process.pid };
    atomicWrite(path.join(directory, 'session.json'), session);
    ownedSession = JSON.stringify(session);
    console.log(`Relay Canvas v0.3.0 — ${origin}`);
    console.log(`Remote generation: ${service.policy.remoteEnabled ? 'enabled (confirmation required)' : 'disabled — Demo is ready'}`);
  });
  server.on('error', () => { console.error('Could not start local server. Check port and workspace ownership.'); process.exitCode = 1; });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { server.close(() => { void closeDev?.().finally(() => process.exit(0)); if (!closeDev) process.exit(0); }); server.closeAllConnections(); });
} catch { console.error('Startup failed. Check the workspace, policy, and server lock. Existing data was preserved.'); process.exitCode = 1; }
