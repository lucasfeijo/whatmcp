import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.ts';
import { tryAcquireSyncLock } from './sync-lock.ts';
import type { SyncProcessOptions } from './sync-process.ts';

interface RunState {
  id: string; started: number; finished?: number; code?: number;
  command: string; args: string[]; identity?: string;
}
function readState(path: string): RunState | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function writeState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${state.id}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
}

/** A stronger request must never be silently fulfilled by a weaker worker. */
export function syncCovers(active: Pick<RunState, 'command' | 'args'>, command: string, args: string[]): boolean {
  if (active.command !== command) return false;
  if (!args.includes('sync-worker') || !active.args.includes('sync-worker')) {
    return JSON.stringify(active.args) === JSON.stringify(args);
  }
  const options = new Set(['--full', '--index-only', '--skip-auto-transcription']);
  if (JSON.stringify(active.args.filter(a => !options.has(a))) !==
      JSON.stringify(args.filter(a => !options.has(a)))) return false;
  if (args.includes('--full') && !active.args.includes('--full')) return false;
  if (!args.includes('--index-only') && active.args.includes('--index-only')) return false;
  if (!args.includes('--index-only') && !args.includes('--skip-auto-transcription') &&
      active.args.includes('--skip-auto-transcription')) return false;
  return true;
}

/** Followers wait for one owner and return its result; they never queue a worker. */
export async function coordinateSync(command: string, args: string[], options: SyncProcessOptions,
  action: () => Promise<number>): Promise<number> {
  const path = options.coordinationPath ?? join(DATA_DIR, 'sync-coordinator.json');
  const requested = Date.now();
  let release = tryAcquireSyncLock(`${path}.lock.db`);
  if (!release) {
    const report = options.onOutput ?? ((message: string) => console.log(message.trim()));
    report('another sync is running; following its result without starting another extraction\n');
    const deadline = requested + (options.timeoutMs ?? 30 * 60_000);
    let observed: string | undefined;
    while (!release) {
      const state = readState(path);
      if (state && state.finished === undefined) observed ??= state.id;
      if (Date.now() >= deadline) return 124;
      await new Promise(resolve => setTimeout(resolve, 100));
      release = tryAcquireSyncLock(`${path}.lock.db`);
    }
    try {
      const state = readState(path);
      if (state && state.identity === options.coordinationIdentity &&
          state.finished !== undefined && Number.isInteger(state.code) &&
          (observed ? state.id === observed : state.finished >= requested) && syncCovers(state, command, args)) {
        report(`shared sync finished with exit ${state.code}\n`);
        return state.code!;
      }
      report('the active sync did not satisfy this request; no extra extraction was queued\n');
      return 75;
    } finally { release(); }
  }
  const state: RunState = { id: randomUUID(), started: requested, command, args, identity: options.coordinationIdentity };
  try {
    writeState(path, state);
    try {
      const code = await action();
      writeState(path, { ...state, finished: Date.now(), code });
      return code;
    } catch (error) {
      writeState(path, { ...state, finished: Date.now(), code: 1 });
      throw error;
    }
  } finally { release(); }
}
