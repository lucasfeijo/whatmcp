/** Reuse the scheduled hot-copy pipeline; WhatsApp stays open throughout. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, type Config } from '../config.ts';
import type { WindowsImportResult } from './windows-import.ts';

/** Prevent overlapping CLI/MCP syncs. The script also locks scheduled runs. */
export async function withWindowsSyncLock<T>(lock: string, action: () => T | Promise<T>): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(readFileSync(lock, 'utf8').trim()); } catch { /* incomplete lock */ }
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error('Windows sync is already running');
        } catch (probe) {
          if (!(probe instanceof Error) || !('code' in probe) || probe.code !== 'ESRCH') throw probe;
        }
      } else {
        // A creator may still be writing the PID; never steal a fresh lock.
        if (Date.now() - statSync(lock).mtimeMs < 60_000) {
          throw new Error('Windows sync is already running');
        }
      }
      unlinkSync(lock);
    }
  }
  if (fd === undefined) throw new Error('Windows sync is already running');
  try {
    writeFileSync(fd, String(process.pid));
    return await action();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock);
    } catch { /* preserve another owner's lock */ }
  }
}


export function runHotCopy(
  script: string, cfg: Config, opts: { full?: boolean; progress?: (s: string) => void } = {},
): Promise<WindowsImportResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DataDirectory', DATA_DIR, '-Waren6Directory', cfg.windowsWaren6Path!,
      '-NodePath', process.execPath, '-StorePath', cfg.store,
      '-CasesDirectory', cfg.windowsOutputDir, '-ResultJson',
      ...(cfg.windowsSourcePath ? ['-SourceDirectory', cfg.windowsSourcePath] : []),
      ...(opts.full ? ['-Full'] : []),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let recent = '';
    let result: WindowsImportResult | undefined;
    let parseError: Error | undefined;
    const line = (value: string) => {
      if (value.startsWith('WHATMCP_HOTCOPY_RESULT=')) {
        try {
          const parsed = JSON.parse(value.slice('WHATMCP_HOTCOPY_RESULT='.length));
          for (const field of ['scanned', 'added', 'recovered', 'skipped', 'windowsBuilt', 'windowsDropped', 'total']) {
            if (!Number.isFinite(parsed?.[field]) || parsed[field] < 0) throw new Error('Invalid hot-copy import result');
          }
          result = parsed;
        } catch (error) { parseError = error as Error; }
      } else if (value.trim()) opts.progress?.(value.trim());
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const output = chunk.toString('utf8');
      recent = (recent + output).slice(-8_000);
      pending += output;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!;
      lines.forEach(line);
    });
    child.stderr.on('data', (chunk: Buffer) => { recent = (recent + chunk.toString('utf8')).slice(-8_000); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (pending) line(pending);
      if (code !== 0) reject(new Error(`Hot-copy sync exited with ${signal ?? code}; recent output: ${recent.slice(-2_000)}`));
      else if (parseError) reject(parseError);
      else if (!result) reject(new Error('Hot-copy sync did not return an import result'));
      else resolve(result);
    });
  });
}

export async function runWindowsIndex(
  cfg: Config, opts: { full?: boolean; progress?: (s: string) => void } = {},
): Promise<WindowsImportResult> {
  if (process.platform !== 'win32') throw new Error('WAren6 source requires Windows');
  if (!cfg.windowsWaren6Path) throw new Error('Set windows_waren6_path in config.json before syncing from Windows');
  const waren6 = join(cfg.windowsWaren6Path, 'waren6.ps1');
  try {
    if (!statSync(waren6).isFile()) throw new Error(`WAren6 script is not a file: ${waren6}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`WAren6 script not found: ${waren6}`);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`WAren6 script inaccessible (${code}): ${waren6}; check read and ancestor traversal permissions for the service account`);
    }
    throw error;
  }
  const script = fileURLToPath(new URL('../../scripts/sync-hotcopy-windows.ps1', import.meta.url));
  if (!existsSync(script)) throw new Error(`Hot-copy script not found: ${script}`);
  return withWindowsSyncLock(join(DATA_DIR, 'windows-sync.lock'), () => {
    opts.progress?.('Copying and validating Windows data while WhatsApp remains open');
    return runHotCopy(script, cfg, opts);
  });
}
