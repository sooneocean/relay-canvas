import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);

// Linux/macOS ps output: RSS is KiB per process, not unique/PSS memory.
export function parseProcessList(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] });
  }
  return rows;
}

// Count the spawned test and descendants, never parent/sibling CI jobs.
export function summarizeProcessTree(rows, rootPid) {
  const byParent = new Map();
  const byPid = new Map();
  for (const entry of rows) {
    byPid.set(entry.pid, entry);
    if (!byParent.has(entry.ppid)) byParent.set(entry.ppid, []);
    byParent.get(entry.ppid).push(entry.pid);
  }
  if (!byPid.has(rootPid)) return { processCount: 0, rssKiB: 0, browserRssKiB: 0, ffmpegRssKiB: 0, top: [] };
  const queue = [rootPid], seen = new Set(), members = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const entry = byPid.get(pid);
    if (entry) members.push(entry);
    for (const child of byParent.get(pid) ?? []) queue.push(child);
  }
  return {
    processCount: members.length,
    rssKiB: members.reduce((sum, entry) => sum + entry.rssKiB, 0),
    browserRssKiB: members.filter(entry => /chrom(e|ium)|headless_shell|crashpad/i.test(entry.command)).reduce((sum, entry) => sum + entry.rssKiB, 0),
    ffmpegRssKiB: members.filter(entry => /ffmpeg|ffprobe/i.test(entry.command)).reduce((sum, entry) => sum + entry.rssKiB, 0),
    top: members.sort((a, b) => b.rssKiB - a.rssKiB).slice(0, 5).map(entry => ({ pid: entry.pid, command: path.basename(entry.command), rssMiB: Number((entry.rssKiB / 1024).toFixed(1)) })),
  };
}
const roundMiB = value => Number((value / 1024).toFixed(1));

async function main() {
  const [suiteId, file] = process.argv.slice(2);
  if (!/^[a-z][a-z-]{0,40}$/.test(suiteId ?? '') || !/^scripts\/[a-z0-9-]+\.ts$/.test(file ?? '')) {
    throw new Error('Usage: node scripts/profile-smoke.mjs <suite-id> scripts/<name>.ts');
  }

  const start = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit' });
  let peak = null, samples = 0, sampleErrors = 0, sampling = null, launchError;
  const capture = async () => {
    if (sampling || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    sampling = (async () => {
      try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
        const current = summarizeProcessTree(parseProcessList(stdout), child.pid);
        if (current.processCount > 0) {
          samples++;
          if (!peak || current.rssKiB > peak.rssKiB) peak = current;
        }
      } catch {
        sampleErrors++;
      }
    })();
    try { await sampling; } finally { sampling = null; }
  };
  const timer = setInterval(() => { void capture(); }, 400);
  timer.unref();
  await capture();
  const { code, signal } = await new Promise(resolve => {
    child.once('error', error => { launchError = String(error); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(timer);
  if (sampling) await sampling;

  const report = {
    suiteId, file, status: code === 0 && !launchError ? 'PASS' : 'FAIL',
    durationMs: Date.now() - start,
    exitCode: code, signal, launchError: launchError ?? null,
    measurement: {
      available: samples > 0,
      source: 'ps process tree RSS sampled at 400ms (Linux/macOS)',
      note: 'Summed RSS may double-count shared memory; short-lived processes may escape polling. Not PSS or system RAM peak.',
      samples, sampleErrors,
      peakTreeRssMiB: peak ? roundMiB(peak.rssKiB) : null,
      peakBrowserRssMiBAtTreePeak: peak ? roundMiB(peak.browserRssKiB) : null,
      peakFfmpegRssMiBAtTreePeak: peak ? roundMiB(peak.ffmpegRssKiB) : null,
      processCountAtPeak: peak?.processCount ?? null,
      topAtPeak: peak?.top ?? [],
    },
  };
  const dir = path.join(process.cwd(), 'work');
  mkdirSync(dir, { recursive: true });
  const outfile = path.join(dir, `e2e-profile-${suiteId}.json`);
  writeFileSync(outfile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`E2E PROFILE ${suiteId}: ${report.status}; wall=${report.durationMs}ms; sampled tree RSS peak=${report.measurement.peakTreeRssMiB ?? 'unavailable'}MiB (${samples} samples)`);
  if (report.status !== 'PASS') process.exitCode = code && code > 0 ? code : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
