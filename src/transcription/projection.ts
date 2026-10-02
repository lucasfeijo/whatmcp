/** Durable, per-conversation projection of original text plus audio transcripts. */
import { chunk, windowHash, type ChunkInput, type Window } from '../index/chunker.ts';
import { modelTag } from '../index/openai.ts';
import { replaceThreadWindows } from '../index/indexer.ts';
import { invalidate } from '../store.ts';
import type { Config } from '../config.ts';
import type { DB } from '../db/index.ts';
import { mediaPath } from './media.ts';

interface SelectedTranscript {
  message_id: string;
  audio_sha256: string;
  model: string;
  model_revision: string;
  locale: string;
  text: string;
}

function selected(db: DB, threadId: string, mode: 'active' | 'candidate', generation?: number):
  SelectedTranscript[] {
  const selector = mode === 'active'
    ? 'JOIN active_transcripts x ON x.message_id = m.id'
    : 'JOIN candidate_transcripts x ON x.message_id = m.id AND x.thread_id = ? AND x.generation = ?';
  return db.prepare(`
    SELECT x.message_id, x.audio_sha256, x.model, x.model_revision, x.locale, t.text
    FROM messages m ${selector}
    JOIN audio_transcripts t ON t.message_id = x.message_id
      AND t.audio_sha256 = x.audio_sha256 AND t.model = x.model
      AND t.model_revision = x.model_revision AND t.locale = x.locale
    WHERE m.thread_id = ? AND t.status = 'done' AND t.text <> ''
  `).all(...(mode === 'candidate' ? [threadId, generation] : []), threadId) as SelectedTranscript[];
}

export function projectionInputs(db: DB, threadId: string,
  mode: 'active' | 'candidate', generation?: number): ChunkInput[] {
  const transcripts = new Map(selected(db, threadId, mode, generation)
    .map((row) => [row.message_id, row]));
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.thread_id, m.ts, m.text,
           CASE WHEN m.is_from_me = 1 THEN 'me'
                ELSE COALESCE(s.display_name, s.id, 'unknown') END AS sender_name
    FROM messages m LEFT JOIN senders s ON s.id = m.sender_id
    WHERE m.thread_id = ? AND (m.text IS NOT NULL AND m.text <> ''
      OR m.id IN (SELECT message_id FROM ${mode === 'active'
        ? 'active_transcripts' : 'candidate_transcripts'}))
    ORDER BY m.ts, m.id
  `).all(threadId) as (Omit<ChunkInput, 'text'> & { text: string | null })[];
  return rows.flatMap((row) => {
    const original = row.text?.trim() ?? '';
    const transcript = transcripts.get(row.message_id);
    const derived = transcript ? `Áudio transcrito (${transcript.model}): ${transcript.text}` : '';
    const text = [original, derived].filter(Boolean).join('\n');
    return text ? [{ ...row, text }] : [];
  });
}

/** Changing the chosen model dirties complete audio conversations, not vectors alone. */
export function reconcileProjectionModel(db: DB, model: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO thread_projection_state(thread_id, desired_model, updated_at)
      SELECT DISTINCT thread_id, ?, ? FROM messages WHERE kind = 'audio'
    `).run(model, now);
    db.prepare(`
      UPDATE thread_projection_state SET
        desired_model = ?, desired_generation = desired_generation + 1,
        status = 'dirty', updated_at = ?
      WHERE desired_model IS NOT ?
    `).run(model, now, model);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

interface State {
  thread_id: string;
  desired_generation: number;
  desired_model: string | null;
  active_model: string | null;
}

/** Build candidates only when every accessible audio has a usable result. */
export function prepareReadyCandidates(db: DB, cfg: Config, limit = 25): number {
  const states = db.prepare(`
    SELECT thread_id, desired_generation, desired_model, active_model
    FROM thread_projection_state
    WHERE desired_generation > active_generation AND status <> 'prepared'
    ORDER BY updated_at, thread_id
  `).all() as State[];
  let prepared = 0;
  for (const state of states) {
    if (prepared >= limit) break;
    const model = state.desired_model;
    // A disabled installation with no previously published transcript has
    // nothing to reproject; keep its original text windows intact.
    if (!model && !state.active_model) {
      db.prepare(`UPDATE thread_projection_state SET active_generation = desired_generation,
        status = 'current' WHERE thread_id = ?`).run(state.thread_id);
      continue;
    }
    const picks: SelectedTranscript[] = [];
    let ready = true;
    const media = db.prepare(`
      SELECT a.message_id, a.source_id, a.relative_path, a.sha256,
             a.availability, m.thread_id
      FROM audio_media a JOIN messages m ON m.id = a.message_id
      WHERE m.thread_id = ?
    `).all(state.thread_id) as {
      message_id: string; source_id: string; relative_path: string;
      sha256: string | null; availability: string; thread_id: string }[];
    for (const row of media) {
      if (!model) continue;
      let available = false;
      try { mediaPath(cfg, row); available = true; } catch { /* absent or unsafe */ }
      const availability = available ? 'available' : 'unavailable';
      if (availability !== row.availability) {
        db.prepare('UPDATE audio_media SET availability = ?, checked_at = ? WHERE message_id = ?')
          .run(availability, Math.floor(Date.now() / 1000), row.message_id);
      }
      if (!available) {
        const old = db.prepare(`
          SELECT a.*, t.text FROM active_transcripts a JOIN audio_transcripts t
            ON t.message_id = a.message_id AND t.audio_sha256 = a.audio_sha256
            AND t.model = a.model AND t.model_revision = a.model_revision
            AND t.locale = a.locale WHERE a.message_id = ? AND t.status = 'done'
        `).get(row.message_id) as SelectedTranscript | undefined;
        if (old) picks.push(old);
        continue;
      }
      if (!row.sha256) { ready = false; continue; }
      const result = db.prepare(`
        SELECT message_id, audio_sha256, model, model_revision, locale, text, status
        FROM audio_transcripts WHERE message_id = ? AND audio_sha256 = ?
          AND model = ? AND model_revision = 'v1' AND locale = ?
      `).get(row.message_id, row.sha256, model, cfg.transcriptionLocale ?? 'pt-BR') as
        (SelectedTranscript & { status: string }) | undefined;
      if (!result || !['done', 'no_speech'].includes(result.status)) {
        ready = false;
      } else if (result.status === 'done') {
        picks.push(result);
      }
    }
    if (!ready) continue;

    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM candidate_transcripts WHERE thread_id = ?').run(state.thread_id);
      db.prepare('DELETE FROM candidate_windows WHERE thread_id = ?').run(state.thread_id);
      const insTranscript = db.prepare(`
        INSERT INTO candidate_transcripts
          (thread_id, generation, message_id, audio_sha256, model, model_revision, locale)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of picks) insTranscript.run(state.thread_id, state.desired_generation,
        t.message_id, t.audio_sha256, t.model, t.model_revision, t.locale);
      const windows = chunk(projectionInputs(db, state.thread_id, 'candidate',
        state.desired_generation));
      const insWindow = db.prepare(`
        INSERT INTO candidate_windows(thread_id, generation, ordinal, start_ts, end_ts,
          msg_count, speakers, text, first_msg_id, last_msg_id, content_hash, parts_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      windows.forEach((w, ordinal) => insWindow.run(state.thread_id,
        state.desired_generation, ordinal, w.start_ts, w.end_ts, w.msg_count,
        w.speakers, w.text, w.first_msg_id, w.last_msg_id, windowHash(w),
        JSON.stringify(w.parts)));
      db.prepare(`UPDATE thread_projection_state SET status = 'prepared'
        WHERE thread_id = ? AND desired_generation = ?`)
        .run(state.thread_id, state.desired_generation);
      db.exec('COMMIT');
      prepared++;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return prepared;
}

/** One transaction switches FTS, active transcript selection, and generation. */
export function publishCandidates(db: DB, cfg: Config, limit = 25): number {
  const states = db.prepare(`
    SELECT thread_id, desired_generation, desired_model FROM thread_projection_state
    WHERE status = 'prepared' AND desired_generation > active_generation
    ORDER BY updated_at, thread_id LIMIT ?
  `).all(limit) as State[];
  let published = 0;
  for (const state of states) {
    const rows = db.prepare(`SELECT * FROM candidate_windows
      WHERE thread_id = ? AND generation = ? ORDER BY ordinal`)
      .all(state.thread_id, state.desired_generation) as (Window & {
        parts_json: string; content_hash: string })[];
    const windows: Window[] = rows.map((r) => ({ ...r, thread_id: state.thread_id,
      parts: JSON.parse(r.parts_json) }));
    const tag = modelTag({ model: cfg.openaiModel, dimensions: cfg.openaiDims });
    const missing = Number((db.prepare(`
      SELECT COUNT(*) n FROM candidate_windows c LEFT JOIN window_vectors v
        ON v.content_hash = c.content_hash AND v.model = ?
      WHERE c.thread_id = ? AND c.generation = ? AND v.content_hash IS NULL
    `).get(tag, state.thread_id, state.desired_generation) as { n: number }).n);
    db.exec('BEGIN');
    try {
      const current = db.prepare(`SELECT desired_generation, status FROM thread_projection_state
        WHERE thread_id = ?`).get(state.thread_id) as { desired_generation: number; status: string };
      if (current.desired_generation !== state.desired_generation || current.status !== 'prepared') {
        db.exec('ROLLBACK');
        continue;
      }
      db.prepare(`DELETE FROM active_transcripts WHERE message_id IN
        (SELECT id FROM messages WHERE thread_id = ?)`).run(state.thread_id);
      db.prepare(`INSERT INTO active_transcripts
        (message_id, audio_sha256, model, model_revision, locale)
        SELECT message_id, audio_sha256, model, model_revision, locale
        FROM candidate_transcripts WHERE thread_id = ? AND generation = ?`)
        .run(state.thread_id, state.desired_generation);
      replaceThreadWindows(db, state.thread_id, windows);
      db.prepare(`UPDATE thread_projection_state SET active_generation = ?,
        active_model = ?, status = ?, updated_at = ? WHERE thread_id = ?`)
        .run(state.desired_generation, state.desired_model,
          missing ? 'vectors_pending' : 'current', Math.floor(Date.now() / 1000),
          state.thread_id);
      db.prepare('DELETE FROM candidate_windows WHERE thread_id = ?').run(state.thread_id);
      db.prepare('DELETE FROM candidate_transcripts WHERE thread_id = ?').run(state.thread_id);
      db.exec('COMMIT');
      published++;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  if (published) invalidate();
  return published;
}
