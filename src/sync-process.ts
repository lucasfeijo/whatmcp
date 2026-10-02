import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';

export const SYNC_TIMEOUT_MS = 5 * 60 * 1000;
export const WINDOWS_SYNC_TIMEOUT_MS = 30 * 60 * 1000;
export function syncTimeoutMs(sourceType: string): number {
  return sourceType === 'windows-waren6' ? WINDOWS_SYNC_TIMEOUT_MS : SYNC_TIMEOUT_MS;
}
const STOP_GRACE_MS = 5 * 1000;
export const SYNC_PAUSE_PATH = join(DATA_DIR, 'sync-paused.json');

export interface SyncProcessOptions {
  timeoutMs?: number;
  graceMs?: number;
  onOutput?: (chunk: string) => void;
  /** Scheduled runs never start while an earlier timeout needs attention. */
  scheduled?: boolean;
  /** Override only for isolated tests. */
  pausePath?: string;
}

export function isScheduledSyncPaused(path = SYNC_PAUSE_PATH): boolean {
  return existsSync(path);
}

function pauseScheduledSync(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path,
    JSON.stringify({ pausedAt: new Date().toISOString(), reason: 'sync timeout' }) + '\n',
    { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function syncWorkerCommand(full = false): [string, string[]] {
  return [process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    join(import.meta.dirname, 'cli.ts'), 'sync-worker',
    ...(full ? ['--full'] : []),
  ]];
}

/** Run sync in a child so a blocked synchronous SQLite copy cannot block its watchdog. */
export async function runSyncProcess(
  command: string,
  args: string[],
  options: SyncProcessOptions = {},
): Promise<number> {
  const { timeoutMs = SYNC_TIMEOUT_MS, graceMs = STOP_GRACE_MS,
    onOutput, scheduled = false, pausePath = SYNC_PAUSE_PATH } = options;
  if (scheduled && isScheduledSyncPaused(pausePath)) {
    console.error('scheduled sync paused after a timeout; run `npm run sync` manually to retry');
    return 76;
  }
  const result = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (onOutput) {
      child.stdout?.on('data', (data: Buffer) => onOutput(data.toString('utf8')));
      child.stderr?.on('data', (data: Buffer) => onOutput(data.toString('utf8')));
    }
    let timedOut = false;
    let forwardedSignal: 'SIGINT' | 'SIGTERM' | undefined;
    let stopTimer: NodeJS.Timeout | undefined;

    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) {
        // Terminate our worker tree before its parent disappears; WhatsApp is
        // never spawned by the worker and is outside this tree.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        killer.once('error', (error) => console.error(`could not stop sync process tree: ${error.message}`));
        killer.once('close', (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) {
            console.error(`taskkill failed with exit ${code}`);
            child.kill('SIGKILL');
          }
        });
        return;
      }
      child.kill(signal);
      stopTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, graceMs);
    };
    const onInterrupt = () => { forwardedSignal = 'SIGINT'; stop('SIGINT'); };
    const onTerminate = () => { forwardedSignal = 'SIGTERM'; stop('SIGTERM'); };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`sync exceeded ${timeoutMs / 1000} seconds; stopping it`);
      // Record the pause while this child still owns the sync lock. A later
      // successful manual run can then clear it without racing this timeout.
      try {
        pauseScheduledSync(pausePath);
        console.error('future scheduled syncs are paused until a manual sync succeeds');
      } catch (error) {
        console.error(`could not record scheduled sync pause: ${String(error)}`);
      }
      stop('SIGTERM');
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(timedOut ? 124 : forwardedSignal
        ? 128 + constants.signals[forwardedSignal]
        : code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
  if (result === 0) {
    rmSync(pausePath, { force: true });
  }
  return result;
}
