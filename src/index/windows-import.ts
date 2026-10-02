/** Import WAren6's SQLite output without replacing the iPhone history. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openStore } from '../db/index.ts';
import { rebuildWindows } from './indexer.ts';
import { phoneOf } from '../whatsapp/source.ts';

export interface WindowsImportResult {
  scanned: number; added: number; recovered: number; skipped: number;
  windowsBuilt: number; windowsDropped: number; total: number;
}

interface Row {
  rowid: number; msg_id: string | null; chat_jid: string; chat_name: string | null;
  sender_jid: string | null; sender_name: string | null; from_me: number | null;
  timestamp: number; text: string | null; is_group: number | null; msg_type: string | null;
}

const kind = (type: string | null) =>
  type === 'chat' ? 'text' : type === 'ptt' ? 'audio' : type === 'gp2' ? 'system' : (type || 'unknown');

export function importWindowsUnified(
  archivePath: string, sourcePath: string, opts: { full?: boolean; progress?: (s: string) => void } = {},
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
      const rows = src.prepare(
        'SELECT rowid,msg_id,chat_jid,chat_name,sender_jid,sender_name,from_me,timestamp,text,is_group,msg_type ' +
        'FROM messages WHERE timestamp>? AND timestamp<=? ORDER BY timestamp,rowid'
      ).all(since, Math.floor(Date.now()/1000)+86400) as Row[];
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
        WHERE messages.text IS NULL AND excluded.text IS NOT NULL
      `);
      const touched = new Set<string>();
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
          else if (old && old.text===null && body && changed) recovered++;
          if (body && changed) touched.add(jid);
          latest=Math.max(latest,ts);
        }
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
      return {scanned:rows.length,added,recovered,skipped,windowsBuilt:w.built,windowsDropped:w.dropped,total};
    } finally { db.close(); }
  } finally { src.close(); }
}
