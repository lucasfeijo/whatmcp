import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, type Config } from './config.ts';

export const ACQUISITION_REUSE_MS = 90_000;
const ACQUISITION_PATH = join(DATA_DIR, 'sync-acquisition.json');
type SourceConfig = Pick<Config, 'sourceType' | 'store' | 'chatstorage' | 'windowsWaren6Path' |
  'windowsSourcePath' | 'windowsOutputDir' | 'mediaSourceId' | 'mediaRoots'>;
export function syncSourceIdentity(cfg: SourceConfig): string {
  return JSON.stringify([cfg.sourceType, cfg.store, cfg.chatstorage, cfg.windowsWaren6Path,
    cfg.windowsSourcePath, cfg.windowsOutputDir, cfg.mediaSourceId, cfg.mediaRoots]);
}
function save(path: string, record: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Only acquisition is reused. The caller must still process pending archive work. */
export function canReuseAcquisition(cfg: SourceConfig, full = false,
  path = ACQUISITION_PATH, now = Date.now()): boolean {
  if (full || !existsSync(cfg.store)) return false;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const age = now - (record.runFinished ?? record.completed);
    return record.identity === syncSourceIdentity(cfg) && Number.isFinite(age) && age >= 0 && age < ACQUISITION_REUSE_MS;
  } catch { return false; }
}

/** Call only after acquisition/import succeeds while holding the sync lock. */
export function recordAcquisition(cfg: SourceConfig, path = ACQUISITION_PATH, now = Date.now()): void {
  save(path, { identity: syncSourceIdentity(cfg), completed: now });
}

/** Only the run that acquired data may extend reuse once after slow processing. */
export function completeAcquisitionRun(cfg: SourceConfig, path = ACQUISITION_PATH, now = Date.now()): void {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.identity !== syncSourceIdentity(cfg) || record.runFinished !== undefined || now < record.completed) return;
  save(path, { ...record, runFinished: now });
}

/** A failed newer attempt must not fall back to an earlier success marker. */
export function invalidateAcquisition(path = ACQUISITION_PATH): void {
  rmSync(path, { force: true });
}
