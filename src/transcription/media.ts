import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { openStore, type DB } from '../db/index.ts';
import { type Config } from '../config.ts';
import { extractAudioReferences, type RawAudioReference } from '../whatsapp/source.ts';

export interface AudioMediaRow {
  message_id: string;
  thread_id: string;
  source_id: string;
  relative_path: string;
  sha256: string | null;
  size_bytes: number | null;
  mtime_ms: number | null;
  availability: string;
}

/** Never let a source-provided path or symlink escape the configured media root. */
export function resolveMediaPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || /^[a-z]:[/\\]/i.test(relativePath)) {
    throw new Error('media path must be relative to its configured root');
  }
  const rootReal = realpathSync(root);
  const path = realpathSync(resolve(rootReal, relativePath));
  const inside = relative(rootReal, path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('media path escapes its configured root');
  }
  if (!statSync(path).isFile()) throw new Error('media path is not a file');
  return path;
}

export function mediaPath(cfg: Config, row: Pick<AudioMediaRow, 'source_id' | 'relative_path'>): string {
  const root = cfg.mediaRoots?.[row.source_id];
  if (!root) throw new Error(`no media root configured for source ${row.source_id}`);
  return resolveMediaPath(root, row.relative_path);
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function markProjectionDirty(db: DB, threadId: string): void {
  db.prepare(`
    INSERT INTO thread_projection_state(thread_id, desired_generation, active_generation, status, updated_at)
    VALUES (?, 1, 0, 'dirty', ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      desired_generation = desired_generation + 1,
      status = 'dirty', updated_at = excluded.updated_at
  `).run(threadId, Math.floor(Date.now() / 1000));
}

/** Called inside the indexer's message transaction. */
export function upsertAudioReferences(db: DB, refs: RawAudioReference[], sourceId: string): number {
  const exists = db.prepare('SELECT source_id, relative_path FROM audio_media WHERE message_id = ?');
  const message = db.prepare('SELECT 1 FROM messages WHERE id = ?');
  const upsert = db.prepare(`
    INSERT INTO audio_media(message_id, source_id, relative_path)
    VALUES (?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      source_id = excluded.source_id, relative_path = excluded.relative_path,
      availability = 'unknown', checked_at = NULL, sha256 = NULL
  `);
  const touched = new Set<string>();
  let changed = 0;
  for (const ref of refs) {
    if (!message.get(ref.message_id)) continue;
    const old = exists.get(ref.message_id) as {
      source_id: string; relative_path: string } | undefined;
    if (old?.source_id === sourceId && old.relative_path === ref.relative_path) continue;
    upsert.run(ref.message_id, sourceId, ref.relative_path);
    touched.add(ref.thread_id);
    changed++;
  }
  for (const threadId of touched) markProjectionDirty(db, threadId);
  return changed;
}

/** Backfill and incremental scanning use an independent watermark per source. */
export function scanSourceMedia(
  db: DB, snapshotPath: string, sourceId: string, sourceMaxPk: number, full = false,
): number {
  const state = db.prepare('SELECT last_source_pk FROM audio_media_sources WHERE source_id = ?')
    .get(sourceId) as { last_source_pk: number } | undefined;
  const since = full || sourceMaxPk < (state?.last_source_pk ?? 0)
    ? 0 : (state?.last_source_pk ?? 0);
  const refs = extractAudioReferences(snapshotPath, since);
  const changed = upsertAudioReferences(db, refs, sourceId);
  db.prepare(`
    INSERT INTO audio_media_sources(source_id, last_source_pk, last_run_at) VALUES (?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      last_source_pk = excluded.last_source_pk, last_run_at = excluded.last_run_at
  `).run(sourceId, sourceMaxPk, Math.floor(Date.now() / 1000));
  return changed;
}

export function listAudioMedia(db: DB): AudioMediaRow[] {
  return db.prepare(`
    SELECT a.*, m.thread_id FROM audio_media a JOIN messages m ON m.id = a.message_id
    ORDER BY m.ts, m.id
  `).all() as AudioMediaRow[];
}

export function mediaStats(db: DB): { referenced: number; available: number; done: number;
  retryable: number; pendingThreads: number; lastError: string | null } {
  const q = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    referenced: q('SELECT COUNT(*) n FROM audio_media'),
    available: q("SELECT COUNT(*) n FROM audio_media WHERE availability = 'available'"),
    done: q("SELECT COUNT(*) n FROM audio_transcripts WHERE status IN ('done','no_speech')"),
    retryable: q("SELECT COUNT(*) n FROM audio_transcripts WHERE status = 'retryable_error'"),
    pendingThreads: q('SELECT COUNT(*) n FROM thread_projection_state WHERE desired_generation > active_generation'),
    lastError: (db.prepare(`SELECT error_code FROM audio_transcripts
      WHERE error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get() as
      { error_code: string } | undefined)?.error_code ?? null,
  };
}
