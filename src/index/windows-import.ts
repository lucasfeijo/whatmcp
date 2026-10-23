/** Import WAren6's SQLite output without replacing the iPhone history. */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA_DIR } from '../config.ts';
import { collectWindowsAudio } from './windows-media.ts';
import { existsSync } from 'node:fs';
import { openStore } from '../db/index.ts';
import { rebuildWindows } from './indexer.ts';
import { markProjectionDirty, upsertAudioReferences } from '../transcription/media.ts';
import { phoneOf } from '../whatsapp/source.ts';

export interface WindowsImportResult {
  scanned: number; added: number; recovered: number; skipped: number;
  windowsBuilt: number; windowsDropped: number; total: number;
  audioReferenced: number; audioRejected: number;
}

interface Row {
  rowid: number; msg_id: string | null; chat_jid: string; chat_name: string | null;
  sender_jid: string | null; sender_name: string | null; from_me: number | null;
  timestamp: number; text: string | null; is_group: number | null; msg_type: string | null;
}

const kind = (type: string | null) =>
  type === 'chat' ? 'text' : type === 'ptt' ? 'audio' : type === 'gp2' ? 'system' : (type || 'unknown');

export function importWindowsUnified(
  archivePath: string, sourcePath: string, opts: { full?: boolean; progress?: (s: string) => void; mediaRoot?: string } = {},
): WindowsImportResult {
  if (!existsSync(sourcePath)) throw new Error(`WAren6 database not found: ${sourcePath}`);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const cols = new Set((src.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(r => r.name));
    for (const name of ['msg_id', 'chat_jid', 'timestamp', 'text', 'from_me', 'sender_jid']) {
      if (!cols.has(name)) throw new Error(`WAren6 messages column missing: ${name}`);
    }
    const check = src.prepare('PRAGMA quick_check').get() as { quick_check: string };
    if (check.quick_check !== 'ok') throw new Error('WAren6 database failed quick_check');
    const db = openStore(archivePath);
    try {
      const state = db.prepare("SELECT last_ts FROM sync_state WHERE id='windows-waren6'").get() as { last_ts: number } | undefined;
      const archiveLatest = Number((db.prepare('SELECT MAX(ts) n FROM messages').get() as { n: number | null }).n ?? 0);
      const since = opts.full ? 0 : state ? Math.max(0, state.last_ts - 7 * 86400) : archiveLatest;
      opts.progress?.(`scanning WAren6 after ${new Date(since * 1000).toISOString()}`);
      // A later extraction may recover an old body. The time watermark must
      // limit new history, but must not exclude repairs to archived messages.
      if (!opts.full) src.prepare('ATTACH DATABASE ? AS archive_recovery').run(archivePath);
      const rows = src.prepare(
        'SELECT s.rowid,s.msg_id,s.chat_jid,s.chat_name,s.sender_jid,s.sender_name,s.from_me,s.timestamp,s.text,s.is_group,s.msg_type ' +
        'FROM messages s WHERE (s.timestamp>?' + (!opts.full ?
          " OR (length(trim(s.text))>0 AND EXISTS (SELECT 1 FROM archive_recovery.messages a " +
          "WHERE a.id=s.chat_jid||':'||s.msg_id AND (a.text IS NULL OR trim(a.text)='')))" : '') +
        ') AND s.timestamp<=? ORDER BY s.timestamp,s.rowid'
      ).all(since, Math.floor(Date.now()/1000)+86400) as Row[];
      const allowedAudio = new Set((db.prepare("SELECT id FROM messages WHERE kind='audio'").all() as {id:string}[]).map(r=>r.id));
      for(const r of rows) if(kind(r.msg_type)==='audio' && r.chat_jid?.trim() && r.msg_id?.trim()) {
        allowedAudio.add(`${r.chat_jid.trim()}:${r.msg_id.trim()}`);
      }
      const audio = collectWindowsAudio(src, sourcePath, opts.mediaRoot ?? join(DATA_DIR, 'media', 'windows'), opts.progress, allowedAudio);
      const thread = db.prepare(`
        INSERT INTO threads (id,title,kind,msg_count,first_ts,last_ts,first_seen_at,last_seen_at)
        VALUES (?,?,?,0,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title=COALESCE(threads.title,excluded.title),
          first_ts=MIN(COALESCE(threads.first_ts,excluded.first_ts),excluded.first_ts),
          last_ts=MAX(COALESCE(threads.last_ts,excluded.last_ts),excluded.last_ts),
          last_seen_at=excluded.last_seen_at
      `);
      const sender = db.prepare(`
        INSERT INTO senders (id,display_name,phone,is_self,first_seen_at,last_seen_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          display_name=COALESCE(senders.display_name,excluded.display_name),
          phone=COALESCE(senders.phone,excluded.phone),last_seen_at=excluded.last_seen_at
      `);
      const exists = db.prepare('SELECT text FROM messages WHERE id=?');
      const message = db.prepare(`
        INSERT INTO messages (id,thread_id,sender_id,ts,text,is_from_me,kind,stanza_id,source_pk,first_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text
        WHERE (messages.text IS NULL OR trim(messages.text)='') AND excluded.text IS NOT NULL
      `);
      const touched = new Set<string>();
      let audioReferenced = 0;
      let added=0, recovered=0, skipped=0, latest=state?.last_ts ?? 0;
      const now=Math.floor(Date.now()/1000);
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const jid=String(r.chat_jid ?? '').trim(), stanza=String(r.msg_id ?? '').trim();
          if (!jid || !stanza) { skipped++; continue; }
          const ts=Number(r.timestamp);
          if (!Number.isSafeInteger(ts) || ts<=0) { skipped++; continue; }
          const id=`${jid}:${stanza}`, old=exists.get(id) as { text:string|null }|undefined;
          const body=r.text?.trim() ? r.text : null, mine=Number(r.from_me)===1;
          const senderId=mine ? 'me' : (r.sender_jid || (r.is_group ? null : jid));
          thread.run(jid,r.chat_name,r.is_group ? 'group':'dm',ts,ts,now,now);
          if (senderId) sender.run(senderId,mine ? 'me':r.sender_name,phoneOf(senderId),mine ? 1:0,now,now);
          const changed=Number(message.run(id,jid,senderId,ts,body,mine ? 1:0,kind(r.msg_type),stanza,r.rowid,now).changes)>0;
          if (!old && changed) added++;
          else if (old && !old.text?.trim() && body && changed) recovered++;
          if (changed && (body || kind(r.msg_type) === 'audio')) {
            markProjectionDirty(db, jid);
            touched.add(jid);
          }
          latest=Math.max(latest,ts);
        }
        const archived = db.prepare('SELECT 1 FROM messages WHERE id=?');
        const currentMedia = db.prepare('SELECT source_id,relative_path FROM audio_media WHERE message_id=?');
        const refs = audio.refs.filter(r => archived.get(r.message_id));
        audioReferenced = new Set(refs.map(r=>r.message_id)).size;
        const changedRefs = refs.filter(r => {
          const old = currentMedia.get(r.message_id) as {source_id:string;relative_path:string}|undefined;
          return old?.source_id !== 'windows' || old.relative_path !== r.relative_path;
        });
        upsertAudioReferences(db, changedRefs, 'windows');
        for (const ref of changedRefs) touched.add(ref.thread_id);
        db.prepare(`
          INSERT INTO sync_state(id,last_source_pk,last_ts,last_run_at,msg_count,full_runs)
          VALUES('windows-waren6',0,?, ?, (SELECT COUNT(*) FROM messages),?)
          ON CONFLICT(id) DO UPDATE SET last_ts=MAX(sync_state.last_ts,excluded.last_ts),
            last_run_at=excluded.last_run_at,msg_count=excluded.msg_count,
            full_runs=sync_state.full_runs+excluded.full_runs
        `).run(latest,now,opts.full ? 1:0);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      const w=rebuildWindows(db,[...touched]);
      db.exec('UPDATE threads SET msg_count=(SELECT COUNT(*) FROM messages WHERE messages.thread_id=threads.id)');
      const total=Number((db.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n);
      return {scanned:rows.length,added,recovered,skipped,windowsBuilt:w.built,windowsDropped:w.dropped,total,audioReferenced,audioRejected:audio.rejected};
    } finally { db.close(); }
  } finally { src.close(); }
}
