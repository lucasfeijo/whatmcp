import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { openStore, type DB } from '../db/index.ts';
import { type Config, type TranscriptionModel } from '../config.ts';
import * as wa from '../whatsapp/source.ts';
import { tryAcquireSyncLock } from '../sync-lock.ts';
import { hashFile, listAudioMedia, markProjectionDirty, mediaPath,
  scanSourceMedia, upsertAudioReferences, type AudioMediaRow } from './media.ts';
import { availableModels, transcribeSegment, TranscriptionError } from './models.ts';
import { prepareReadyCandidates, publishCandidates,
  reconcileProjectionModel } from './projection.ts';

const exec = promisify(execFile);
const REVISION = 'v1';
const LEASE_SECONDS = 5 * 60;
const SEGMENT_SECONDS = 10 * 60; // 16 kHz mono WAV stays below 25 MB.

export async function scanConfiguredSource(cfg: Config, full = false): Promise<number> {
  const snapshot = wa.snapshot(cfg.chatstorage);
  const db = openStore(cfg.store);
  try {
    const max = wa.sourceCounts(snapshot).maxPk;
    db.exec('BEGIN');
    try {
      const changed = scanSourceMedia(db, snapshot, cfg.mediaSourceId ?? 'import', max, full);
      db.exec('COMMIT');
      return changed;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
    rmSync(dirname(snapshot), { recursive: true, force: true });
  }
}

export function importMediaManifest(db: DB, sourceId: string, root: string,
  path: string): { imported: number; rejected: number } {
  const rows = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(rows)) throw new Error('media manifest must be a JSON array');
  const refs: { message_id: string; thread_id: string; source_pk: number;
    relative_path: string }[] = [];
  let rejected = 0;
  for (const value of rows) {
    const item = value as { message_id?: unknown; relative_path?: unknown };
    if (typeof item.message_id !== 'string' || typeof item.relative_path !== 'string') {
      rejected++; continue;
    }
    const thread = db.prepare('SELECT thread_id FROM messages WHERE id = ? AND kind = ?')
      .get(item.message_id, 'audio') as { thread_id: string } | undefined;
    if (!thread) { rejected++; continue; }
    try { mediaPath({ mediaRoots: { [sourceId]: root } } as Config,
      { source_id: sourceId, relative_path: item.relative_path }); }
    catch { rejected++; continue; }
    refs.push({ message_id: item.message_id, thread_id: thread.thread_id,
      source_pk: 0, relative_path: item.relative_path });
  }
  db.exec('BEGIN');
  try {
    const imported = upsertAudioReferences(db, refs, sourceId);
    db.exec('COMMIT');
    return { imported, rejected };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

async function command(binary: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const result = await exec(binary, args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true });
    return result.stdout.trim();
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') throw new TranscriptionError(`${binary} not found in PATH`, false);
    if (error.killed) throw new TranscriptionError(`${binary} timed out`, true);
    throw new TranscriptionError(`${binary} failed`, false);
  }
}

async function durationSeconds(cfg: Config, path: string): Promise<number> {
  const raw = await command(cfg.ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], 30_000);
  const duration = Number(raw);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TranscriptionError('could not determine audio duration', false);
  }
  return duration;
}

export async function inventoryAudio(cfg: Config): Promise<{
  available: number; unavailable: number; durationS: number; durationUnknown: number;
  estimatedSeconds: number; estimatedCostUSD: number;
}> {
  const db = openStore(cfg.store);
  let available = 0, unavailable = 0, durationS = 0, durationUnknown = 0;
  try {
    const rows = db.prepare('SELECT message_id, source_id, relative_path FROM audio_media')
      .all() as AudioMediaRow[];
    for (const row of rows) {
      let path: string;
      try { path = mediaPath(cfg, row); }
      catch { unavailable++; continue; }
      available++;
      try {
        const duration = await durationSeconds(cfg, path);
        durationS += duration;
        db.prepare(`UPDATE audio_media SET duration_s = ?, availability = 'available',
          checked_at = ? WHERE message_id = ?`)
          .run(duration, Math.floor(Date.now() / 1000), row.message_id);
      } catch { durationUnknown++; }
    }
  } finally { db.close(); }
  const model = cfg.transcriptionModel;
  const estimatedSeconds = model === 'apple-speech'
    ? .229 * available + .00587 * durationS
    : model === 'apple-dictation'
      ? .216 * available + .0198 * durationS
      : 1.174 * available + .03085 * durationS;
  return { available, unavailable, durationS, durationUnknown, estimatedSeconds,
    estimatedCostUSD: model === 'gpt-transcribe' ? durationS / 60 * .0045 : 0 };
}

async function convertSegment(cfg: Config, source: string, segment: number,
  destination: string): Promise<void> {
  await command(cfg.ffmpegPath ?? 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(segment * SEGMENT_SECONDS), '-i', source,
    '-t', String(SEGMENT_SECONDS), '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', destination,
  ], 300_000);
  if (statSync(destination).size > 25_000_000) {
    throw new TranscriptionError('converted segment exceeds 25 MB', false);
  }
}

function claim(db: DB, row: AudioMediaRow, sha: string,
  model: TranscriptionModel, locale: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT OR IGNORE INTO audio_transcripts
      (message_id, audio_sha256, model, model_revision, locale, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(row.message_id, sha, model, REVISION, locale, now);
  const result = db.prepare(`
    UPDATE audio_transcripts SET status = 'processing', attempts = attempts + 1,
      lease_until = ?, updated_at = ?, error_code = NULL
    WHERE message_id = ? AND audio_sha256 = ? AND model = ?
      AND model_revision = ? AND locale = ?
      AND (status IN ('pending', 'retryable_error')
        OR (status = 'processing' AND lease_until < ?))
  `).run(now + LEASE_SECONDS, now, row.message_id, sha, model, REVISION, locale, now);
  return Number(result.changes) === 1;
}

function setResult(db: DB, row: AudioMediaRow, sha: string,
  model: TranscriptionModel, locale: string, status: string,
  text: string | null, errorCode: string | null): void {
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE audio_transcripts SET status = ?, text = ?, error_code = ?,
        lease_until = NULL, updated_at = ?
      WHERE message_id = ? AND audio_sha256 = ? AND model = ?
        AND model_revision = ? AND locale = ?
    `).run(status, text, errorCode, Math.floor(Date.now() / 1000),
      row.message_id, sha, model, REVISION, locale);
    if (status === 'done' || status === 'no_speech') markProjectionDirty(db, row.thread_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface TranscriptionRun {
  processed: number;
  noSpeech: number;
  unavailable: number;
  failed: number;
  prepared: number;
  published: number;
}

export async function runTranscription(cfg: Config, options: {
  limit?: number;
  retryErrors?: boolean;
  onProgress?: (message: string) => void;
  /** Test-only adapter; the default uses the configured real provider. */
  transcribe?: typeof transcribeSegment;
  convert?: typeof convertSegment;
  duration?: typeof durationSeconds;
} = {}): Promise<TranscriptionRun> {
  const model = cfg.transcriptionModel;
  if (!model) throw new Error('Transcription is disabled; choose transcription_model first.');
  if (!options.transcribe) {
    const available = (await availableModels(cfg)).find((m) => m.model === model);
    if (!available?.available) {
      throw new Error(`${model} unavailable: ${available?.reason ?? 'unknown reason'}`);
    }
  }
  const release = tryAcquireSyncLock(join(dirname(cfg.store), 'transcription-lock.db'));
  if (!release) throw new Error('another transcription worker is already running');
  const db = openStore(cfg.store);
  const result: TranscriptionRun = {
    processed: 0, noSpeech: 0, unavailable: 0, failed: 0, prepared: 0, published: 0,
  };
  const locale = cfg.transcriptionLocale ?? 'pt-BR';
  const say = options.onProgress ?? (() => {});
  try {
    reconcileProjectionModel(db, model);
    if (options.retryErrors) db.prepare(`UPDATE audio_transcripts
      SET status = 'retryable_error', attempts = 0, error_code = NULL, lease_until = NULL
      WHERE model = ? AND locale = ? AND status = 'permanent_error'`)
      .run(model, locale);
    const rows = listAudioMedia(db);
    for (const row of rows) {
      if (result.processed + result.failed >= (options.limit ?? Infinity)) break;
      let path: string;
      try { path = mediaPath(cfg, row); }
      catch {
        db.prepare('UPDATE audio_media SET availability = ?, checked_at = ? WHERE message_id = ?')
          .run('unavailable', Math.floor(Date.now() / 1000), row.message_id);
        result.unavailable++;
        continue;
      }
      const stat = statSync(path);
      const previous = row.sha256;
      const sameFile = row.mtime_ms === stat.mtimeMs && row.size_bytes === stat.size;
      const sha = await hashFile(path);
      if (!sameFile || previous !== sha || row.availability !== 'available') {
        db.exec('BEGIN');
        try {
          db.prepare(`UPDATE audio_media SET sha256 = ?, size_bytes = ?, mtime_ms = ?,
            availability = 'available', checked_at = ? WHERE message_id = ?`)
            .run(sha, stat.size, stat.mtimeMs, Math.floor(Date.now() / 1000), row.message_id);
          if (previous !== sha) markProjectionDirty(db, row.thread_id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
      if (!claim(db, row, sha, model, locale)) continue;
      const tempDir = mkdtempSync(join(tmpdir(), 'whatmcp-audio-'));
      try {
        const count = Math.max(1, Math.ceil(await (options.duration ?? durationSeconds)(cfg, path) / SEGMENT_SECONDS));
        const texts: string[] = [];
        for (let n = 0; n < count; n++) {
          const prior = db.prepare(`
            SELECT text FROM transcript_segments WHERE message_id = ? AND audio_sha256 = ?
              AND model = ? AND model_revision = ? AND locale = ? AND segment_no = ?
          `).get(row.message_id, sha, model, REVISION, locale, n) as { text: string } | undefined;
          if (prior) { texts.push(prior.text); continue; }
          const wav = join(tempDir, `part-${n}.wav`);
          await (options.convert ?? convertSegment)(cfg, path, n, wav);
          const text = await (options.transcribe ?? transcribeSegment)(
            model, locale, wav, cfg.openaiKey);
          db.prepare(`
            INSERT OR REPLACE INTO transcript_segments
              (message_id, audio_sha256, model, model_revision, locale, segment_no, text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(row.message_id, sha, model, REVISION, locale, n, text);
          db.prepare(`UPDATE audio_transcripts SET lease_until = ?
            WHERE message_id = ? AND audio_sha256 = ? AND model = ?
              AND model_revision = ? AND locale = ?`)
            .run(Math.floor(Date.now() / 1000) + LEASE_SECONDS,
              row.message_id, sha, model, REVISION, locale);
          texts.push(text);
        }
        const text = texts.filter(Boolean).join(' ').trim();
        setResult(db, row, sha, model, locale, text ? 'done' : 'no_speech', text, null);
        result.processed++;
        if (!text) result.noSpeech++;
        say(`${result.processed} audio(s) transcribed`);
      } catch (e) {
        const error = e instanceof TranscriptionError ? e
          : new TranscriptionError('transcription/conversion failed', true);
        const attempts = Number((db.prepare(`SELECT attempts n FROM audio_transcripts
          WHERE message_id = ? AND audio_sha256 = ? AND model = ?
            AND model_revision = ? AND locale = ?`)
          .get(row.message_id, sha, model, REVISION, locale) as { n: number }).n);
        setResult(db, row, sha, model, locale,
          error.retryable && attempts < 3 ? 'retryable_error' : 'permanent_error',
          null, error.message);
        result.failed++;
        say(`audio failed: ${error.message}`);
        if (error.pauseModel) break;
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
    // A run publishes FTS atomically by conversation. Embedding is a separate,
    // costed step: `embed` already resumes by content hash after interruption.
    for (;;) {
      const n = prepareReadyCandidates(db, cfg, 100);
      result.prepared += n;
      result.published += publishCandidates(db, cfg, 100);
      if (n === 0) break;
    }
    return result;
  } finally {
    db.close();
    release();
  }
}
