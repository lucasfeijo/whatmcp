/**
 * Indexer: snapshot -> extract -> upsert -> window -> FTS.
 *
 * Safe to run repeatedly. Incremental by Z_PK watermark; any thread that gained
 * text has its windows recomputed and diffed, which keeps window boundaries
 * correct when a burst arrives across several runs.
 *
 * ARCHIVE SEMANTICS, and the reason this file differs from a plain cache indexer:
 * nothing here ever deletes a message, thread, or sender. WhatsApp Desktop prunes
 * its own store and unlinking the device can empty it outright, so a "rebuild from
 * source" that truncated first would silently destroy the only surviving copy of
 * old history. A full pass re-reads everything and upserts; it does not start from
 * an empty table.
 */

import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore, type DB } from '../db/index.ts';
import * as wa from '../whatsapp/source.ts';
import { chunk, windowHash, type Window } from './chunker.ts';
import { markProjectionDirty, scanSourceMedia } from '../transcription/media.ts';
import { projectionInputs } from '../transcription/projection.ts';

const SYNC_ID = 'whatsapp';

export interface IndexResult {
  scanned: number;
  newMessages: number;
  updatedMessages: number;
  threadsTouched: number;
  windowsBuilt: number;
  windowsDropped: number;
  totalMessages: number;
  watermark: number;
  fullPass: boolean;
  sourceReset: boolean;
}

export interface IndexOptions {
  chatstorage: string;
  full?: boolean;
  /** Use a snapshot someone else made; its lifetime stays theirs. */
  snapshotPath?: string;
  mediaSourceId?: string;
  onProgress?: (msg: string) => void;
}

export function runIndex(storePath: string, opts: IndexOptions): IndexResult {
  const db = openStore(storePath);
  const snap = opts.snapshotPath ?? wa.snapshot(opts.chatstorage);
  const ownSnapshot = !opts.snapshotPath;
  const say = opts.onProgress ?? (() => {});

  try {
    const state = db
      .prepare('SELECT last_source_pk, full_runs FROM sync_state WHERE id = ?')
      .get(SYNC_ID) as { last_source_pk: number; full_runs: number } | undefined;

    const storedWatermark = state?.last_source_pk ?? 0;
    const source = wa.sourceCounts(snap);

    /*
     * Detect a source reset.
     *
     * Z_PK is a local rowid. Unlink the device or let WhatsApp rebuild its store
     * and the numbering restarts, so the live max drops below our watermark. An
     * incremental run would then ask for `Z_PK > 50126` against a store whose
     * highest key is 900, extract nothing, and report success — forever. The
     * archive would freeze silently while looking perfectly healthy.
     */
    const sourceReset = source.maxPk < storedWatermark;
    if (sourceReset) {
      say(
        `source watermark went backwards (${storedWatermark} -> ${source.maxPk}): ` +
          `WhatsApp's local store was rebuilt. Falling back to a full pass; ` +
          `nothing already archived is lost.`,
      );
    }

    const fullPass = !!opts.full || sourceReset;
    const sincePk = fullPass ? 0 : storedWatermark;

    const raw = wa.extract(snap, sincePk);
    const watermark = Math.max(source.maxPk, fullPass ? 0 : storedWatermark);
    const now = Math.floor(Date.now() / 1000);

    const upSender = db.prepare(`
      INSERT INTO senders (id, display_name, phone, is_self, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, senders.display_name),
        phone        = COALESCE(excluded.phone, senders.phone),
        last_seen_at = excluded.last_seen_at
    `);
    const upThread = db.prepare(`
      INSERT INTO threads (id, title, kind, msg_count, first_ts, last_ts, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title    = COALESCE(excluded.title, threads.title),
        first_ts = MIN(COALESCE(threads.first_ts, excluded.first_ts), excluded.first_ts),
        last_ts  = MAX(COALESCE(threads.last_ts,  excluded.last_ts),  excluded.last_ts),
        last_seen_at = excluded.last_seen_at
    `);
    /*
     * first_seen_at is preserved on conflict, deliberately. It records when this
     * archive first captured the message, which is the only evidence available
     * that a message predates a source wipe — and re-stamping it on every full
     * pass would erase exactly that.
     */
    const upMessage = db.prepare(`
      INSERT INTO messages
        (id, thread_id, sender_id, ts, text, is_from_me, kind,
         stanza_id, source_pk, first_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text      = excluded.text,
        kind      = excluded.kind,
        sender_id = COALESCE(excluded.sender_id, messages.sender_id),
        source_pk = excluded.source_pk
      WHERE messages.text IS NOT excluded.text OR messages.kind IS NOT excluded.kind
    `);

    const existing = db.prepare('SELECT 1 FROM messages WHERE id = ?');

    const touched = new Set<string>();
    const audioTouched = new Set<string>();
    let newMessages = 0;
    let updatedMessages = 0;

    db.exec('BEGIN');
    try {
      for (const m of raw) {
        const isNew = !existing.get(m.id);

        upThread.run(m.thread_id, m.thread_title, m.thread_kind, m.ts, m.ts, now, now);
        if (m.sender_id) {
          upSender.run(
            m.sender_id,
            m.sender_name,
            wa.phoneOf(m.sender_id),
            m.is_from_me ? 1 : 0,
            now,
            now,
          );
        }

        const res = upMessage.run(
          m.id, m.thread_id, m.sender_id, m.ts, m.text, m.is_from_me,
          wa.messageKind(m.msg_type), m.stanza_id, m.source_pk, now,
        );

        if (isNew) newMessages++;
        else if (Number(res.changes) > 0) updatedMessages++;

        // Only text changes can move a window boundary, so only text messages mark
        // a thread for rebuild. An unchanged existing message must not: on a full
        // pass that would mark every thread and rebuild 5k windows to gain nothing.
        if (wa.isTexty(m) && (isNew || Number(res.changes) > 0)) touched.add(m.thread_id);
        if (wa.messageKind(m.msg_type) === 'audio' && (isNew || Number(res.changes) > 0)) {
          audioTouched.add(m.thread_id);
        }
      }
      scanSourceMedia(db, snap, opts.mediaSourceId ?? 'macos', source.maxPk, fullPass);
      for (const threadId of audioTouched) markProjectionDirty(db, threadId);
      const hasProjection = db.prepare('SELECT 1 FROM thread_projection_state WHERE thread_id = ?');
      for (const threadId of touched) {
        if (hasProjection.get(threadId)) markProjectionDirty(db, threadId);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    say(`${newMessages} new, ${updatedMessages} updated, ${touched.size} thread(s) to rewindow`);

    const { built, dropped } = rebuildWindows(db, [...touched]);

    db.prepare(`
      INSERT INTO sync_state (id, last_source_pk, last_ts, last_run_at, msg_count, full_runs)
      VALUES (?, ?, (SELECT MAX(ts) FROM messages), ?, (SELECT COUNT(*) FROM messages), ?)
      ON CONFLICT(id) DO UPDATE SET
        last_source_pk = excluded.last_source_pk,
        last_ts        = excluded.last_ts,
        last_run_at    = excluded.last_run_at,
        msg_count      = excluded.msg_count,
        full_runs      = sync_state.full_runs + excluded.full_runs
    `).run(SYNC_ID, watermark, now, fullPass ? 1 : 0);

    // Keep denormalized counts honest for list_chats.
    db.exec(`
      UPDATE threads SET msg_count = (
        SELECT COUNT(*) FROM messages WHERE messages.thread_id = threads.id
      )
    `);

    const total = Number((db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c);

    return {
      scanned: raw.length,
      newMessages,
      updatedMessages,
      threadsTouched: touched.size,
      windowsBuilt: built,
      windowsDropped: dropped,
      totalMessages: total,
      watermark,
      fullPass,
      sourceReset,
    };
  } finally {
    db.close();
    if (ownSnapshot) rmSync(dirname(snap), { recursive: true, force: true });
  }
}

/**
 * Rebuild windows for the given threads, writing only what actually changed.
 *
 * The naive version drops and recreates every window in any touched thread. On a
 * real store that means a daily sync destroying ~1,600 windows to gain ~50 — which
 * is harmless when a window costs microseconds and expensive once each one costs an
 * embedding and an API call.
 *
 * So: chunk in memory, hash each window, diff against what is stored, write the
 * difference. Vectors are keyed by the same hash, so untouched windows keep theirs
 * and a re-chunked-but-identical window costs nothing.
 */
export function rebuildWindows(
  db: DB,
  threadIds: string[],
): { built: number; dropped: number } {
  if (threadIds.length === 0) return { built: 0, dropped: 0 };

  let built = 0;
  let dropped = 0;

  db.exec('BEGIN');
  try {
    for (const threadId of threadIds) {
      const fresh = chunk(projectionInputs(db, threadId, 'active'));
      const result = replaceThreadWindows(db, threadId, fresh);
      built += result.built;
      dropped += result.dropped;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { built, dropped };
}

/** Caller owns the transaction, including publication of transcript selection. */
export function replaceThreadWindows(db: DB, threadId: string, fresh: Window[]): {
  built: number; dropped: number } {
  const existing = db.prepare(`
    SELECT id, content_hash, text, speakers, first_msg_id, last_msg_id
    FROM windows WHERE thread_id = ?
  `);
  // A contentless FTS5 table needs the original column values to delete a row.
  const delFts = db.prepare(
    "INSERT INTO windows_fts(windows_fts, rowid, text, speakers) VALUES('delete', ?, ?, ?)",
  );
  const delWin = db.prepare('DELETE FROM windows WHERE id = ?');
  const insWin = db.prepare(`
    INSERT INTO windows
      (thread_id, start_ts, end_ts, msg_count, speakers, text,
       first_msg_id, last_msg_id, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insFts = db.prepare('INSERT INTO windows_fts(rowid, text, speakers) VALUES (?, ?, ?)');
  const delParts = db.prepare('DELETE FROM window_message_parts WHERE window_id = ?');
  const insPart = db.prepare(`
    INSERT OR IGNORE INTO window_message_parts(window_id, message_id, part_no)
    VALUES (?, ?, ?)
  `);

  let built = 0;
  let dropped = 0;

  const identity = (w: { content_hash: string | null; first_msg_id: string;
    last_msg_id: string }) => `${w.content_hash}\x1f${w.first_msg_id}\x1f${w.last_msg_id}`;
  const old = new Map<string, { id: number; text: string; speakers: string }[]>();
  for (const row of existing.all(threadId) as {
    id: number; content_hash: string | null; text: string; speakers: string;
    first_msg_id: string; last_msg_id: string }[]) {
    const key = identity(row);
    const list = old.get(key) ?? [];
    list.push(row);
    old.set(key, list);
  }
  for (const w of fresh) {
    const hash = windowHash(w);
    const key = identity({ content_hash: hash, first_msg_id: w.first_msg_id,
      last_msg_id: w.last_msg_id });
    const kept = old.get(key)?.shift();
    const id = kept ? kept.id : Number(insWin.run(
      w.thread_id, w.start_ts, w.end_ts, w.msg_count,
      w.speakers, w.text, w.first_msg_id, w.last_msg_id, hash,
    ).lastInsertRowid);
    if (!kept) {
      insFts.run(id, w.text, w.speakers);
      built++;
    }
    delParts.run(id);
    for (const part of w.parts) insPart.run(id, part.message_id, part.part_no);
  }
  for (const rows of old.values()) {
    for (const row of rows) {
      delFts.run(row.id, row.text, row.speakers);
      delParts.run(row.id);
      delWin.run(row.id);
      dropped++;
    }
  }

  return { built, dropped };
}
