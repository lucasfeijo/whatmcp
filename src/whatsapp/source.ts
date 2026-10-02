/**
 * WhatsApp Desktop (macOS) source adapter.
 *
 * Reads the Core Data store WhatsApp keeps in its shared group container and maps
 * it onto WhatMCP's shape. Three facts about that store drive the design:
 *
 *  1. It is live and WAL-mode. We never read it in place — the .sqlite/-wal/-shm
 *     triple is snapshotted first, so a checkpoint mid-read cannot tear a
 *     transaction underneath us. Missing the -wal is the subtle failure: it holds
 *     committed-but-uncheckpointed rows, i.e. exactly the newest messages.
 *
 *  2. It is Core Data. Timestamps are Apple epoch (2001-01-01), every column is
 *     Z-prefixed, and relationships are Z_PK joins.
 *
 *  3. Sender names are genuinely hard — see resolveNames() below.
 */

import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSourceRO } from '../db/index.ts';

export const APPLE_EPOCH_OFFSET = 978307200;

export interface RawMessage {
  source_pk: number;
  stanza_id: string | null;
  /** "{thread_jid}:{stanza_id}" — stable across a WhatsApp store wipe. */
  id: string;
  thread_id: string;
  thread_title: string | null;
  thread_kind: 'dm' | 'group';
  sender_id: string | null;
  sender_name: string | null;
  ts: number;
  text: string | null;
  is_from_me: number;
  msg_type: number;
}

export interface RawAudioReference {
  message_id: string;
  thread_id: string;
  source_pk: number;
  relative_path: string;
}

/**
 * Copy the live store somewhere safe to read. Returns the snapshot path; the
 * caller owns the temp directory's lifetime.
 */
export function snapshot(livePath: string): string {
  if (!existsSync(livePath)) {
    throw new Error(
      `WhatsApp store not found at ${livePath}\n` +
        `Is WhatsApp Desktop installed and signed in on this Mac?`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-'));
  const dest = join(dir, 'ChatStorage.sqlite');
  copyFileSync(livePath, dest);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(livePath + ext)) copyFileSync(livePath + ext, dest + ext);
  }
  return dest;
}

/** Bytes and mtime of the live store, for freshness reporting. */
export function sourceInfo(livePath: string): { exists: boolean; size: number; mtime: number } {
  if (!existsSync(livePath)) return { exists: false, size: 0, mtime: 0 };
  const st = statSync(livePath);
  return { exists: true, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
}

/**
 * Pseudo-chats that are not conversations.
 *
 * `status@broadcast` and the per-contact `*@status` rows are status-update feeds.
 * They carry text and would otherwise be indexed as if they were chats, filling
 * search results with one-line status posts nobody addressed to the user.
 */
function isRealChat(jid: string): boolean {
  if (!jid) return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@status') || jid.endsWith('.status')) return false;
  if (jid.endsWith('@broadcast')) return false;
  return true;
}

export interface NameMap {
  /** jid -> best known display name. */
  names: Map<string, string>;
  /** jid -> phone digits, when the jid encodes one. */
  phones: Map<string, string>;
}

/**
 * Build the jid -> name map, in ascending order of trust.
 *
 * This is the fiddly part of the whole adapter, and the naive version loses most
 * names. Measured on a real 50k-message store:
 *
 *   ZWAGROUPMEMBER.ZCONTACTNAME    0 of 15,152 rows populated
 *   ZWAGROUPMEMBER.ZFIRSTNAME      base64 protobuf blobs, not names
 *   ZWAPROFILEPUSHNAME.ZPUSHNAME   covers 92.6% of group messages
 *   ZWACHATSESSION.ZPARTNERNAME    the user's own saved contact names
 *
 * Modern WhatsApp identifies group members by `@lid` (a per-account linked
 * identity), not by phone JID, so a group member and the same person's DM thread
 * do not share a key by default. But WhatsApp also opens `@lid`-keyed DM sessions,
 * and joining on those recovers 230 senders that have no pushname at all — and
 * upgrades another 28 from a self-declared pushname to the name the user actually
 * saved for them.
 *
 * Precedence is deliberate: what the user chose to call someone beats what that
 * person calls themselves.
 */
export function resolveNames(db: ReturnType<typeof openSourceRO>): NameMap {
  const names = new Map<string, string>();
  const phones = new Map<string, string>();

  const put = (jid: unknown, name: unknown) => {
    if (!jid || !name) return;
    const j = String(jid);
    const n = String(name).trim();
    if (!n) return;
    names.set(j, n);
  };

  // 3rd: group member contact names. Empty on current WhatsApp builds, kept
  // because it is populated on older ones and costs one cheap scan.
  for (const r of db
    .prepare(`SELECT ZMEMBERJID j, ZCONTACTNAME n FROM ZWAGROUPMEMBER
              WHERE ZCONTACTNAME IS NOT NULL AND ZCONTACTNAME <> ''`)
    .all() as any[]) {
    put(r.j, r.n);
  }

  // 2nd: self-declared push names.
  for (const r of db
    .prepare(`SELECT ZJID j, ZPUSHNAME n FROM ZWAPROFILEPUSHNAME
              WHERE ZPUSHNAME IS NOT NULL AND ZPUSHNAME <> ''`)
    .all() as any[]) {
    put(r.j, r.n);
  }

  // 1st: the user's own address book, as WhatsApp sees it. Highest trust, so last.
  for (const r of db
    .prepare(`SELECT ZCONTACTJID j, ZPARTNERNAME n FROM ZWACHATSESSION
              WHERE ZPARTNERNAME IS NOT NULL AND ZPARTNERNAME <> ''
                AND ZCONTACTJID NOT LIKE '%@g.us'`)
    .all() as any[]) {
    put(r.j, r.n);
  }

  for (const jid of names.keys()) {
    const digits = phoneOf(jid);
    if (digits) phones.set(jid, digits);
  }

  return { names, phones };
}

/** Phone digits, when the jid is a phone JID. @lid ids encode no phone number. */
export function phoneOf(jid: string): string | null {
  const m = /^(\d{7,15})@s\.whatsapp\.net$/.exec(jid);
  return m ? m[1] : null;
}

const EXTRACT_SQL = `
SELECT
  m.Z_PK                                AS pk,
  m.ZSTANZAID                           AS stanza_id,
  c.ZCONTACTJID                         AS thread_jid,
  c.ZPARTNERNAME                        AS thread_title,
  m.ZISFROMME                           AS is_from_me,
  m.ZMESSAGETYPE                        AS msg_type,
  m.ZTEXT                               AS text,
  CAST(m.ZMESSAGEDATE AS INTEGER)       AS apple_ts,
  gm.ZMEMBERJID                         AS member_jid
FROM ZWAMESSAGE m
JOIN      ZWACHATSESSION c      ON c.Z_PK      = m.ZCHATSESSION
LEFT JOIN ZWAGROUPMEMBER  gm    ON gm.Z_PK     = m.ZGROUPMEMBER
WHERE m.Z_PK > ?
  AND c.ZCONTACTJID IS NOT NULL
ORDER BY m.Z_PK
`;

/**
 * Pull messages with Z_PK greater than the watermark. Pass 0 for everything.
 *
 * Z_PK is monotonic for inserts, so this is cheap and correct for new messages. It
 * does not observe edits or deletes of older rows — deletes are intentionally not
 * propagated (this is an archive), and edits are picked up by a full pass.
 */
export function extract(snapshotPath: string, sincePk = 0): RawMessage[] {
  const db = openSourceRO(snapshotPath);
  try {
    const { names } = resolveNames(db);
    const rows = db.prepare(EXTRACT_SQL).all(sincePk) as Record<string, any>[];
    const out: RawMessage[] = [];

    for (const r of rows) {
      const jid = String(r.thread_jid);
      if (!isRealChat(jid)) continue;

      const isGroup = jid.endsWith('@g.us');
      // Stanza ids are occasionally null on very old rows; fall back to the local
      // primary key so a message is never dropped. Such an id is not stable across
      // a WhatsApp store wipe, which is the accepted cost of not losing the row.
      const stanza = r.stanza_id ? String(r.stanza_id) : null;
      const id = `${jid}:${stanza ?? `pk-${r.pk}`}`;

      let senderId: string | null;
      let senderName: string | null;
      if (r.is_from_me) {
        senderId = 'me';
        senderName = 'me';
      } else if (isGroup) {
        senderId = r.member_jid ? String(r.member_jid) : null;
        senderName = senderId ? (names.get(senderId) ?? null) : null;
      } else {
        senderId = jid;
        senderName = names.get(jid) ?? (r.thread_title ? String(r.thread_title) : null);
      }

      out.push({
        source_pk: Number(r.pk),
        stanza_id: stanza,
        id,
        thread_id: jid,
        thread_title: r.thread_title ? String(r.thread_title) : null,
        thread_kind: isGroup ? 'group' : 'dm',
        sender_id: senderId,
        sender_name: senderName,
        ts: Number(r.apple_ts) + APPLE_EPOCH_OFFSET,
        text: r.text ? String(r.text) : null,
        is_from_me: r.is_from_me ? 1 : 0,
        msg_type: Number(r.msg_type ?? 0),
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Extract only media references. Older compatible sources may lack these columns. */
export function extractAudioReferences(snapshotPath: string, sincePk = 0): RawAudioReference[] {
  const db = openSourceRO(snapshotPath);
  try {
    const columns = (db.prepare('PRAGMA table_info(ZWAMESSAGE)').all() as { name: string }[])
      .map((row) => row.name);
    const hasMediaTable = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ZWAMEDIAITEM'",
    ).get();
    if (!columns.includes('ZMEDIAITEM') || !hasMediaTable) return [];
    const rows = db.prepare(`
      SELECT m.Z_PK pk, m.ZSTANZAID stanza_id, c.ZCONTACTJID thread_jid,
             media.ZMEDIALOCALPATH relative_path
      FROM ZWAMESSAGE m
      JOIN ZWACHATSESSION c ON c.Z_PK = m.ZCHATSESSION
      JOIN ZWAMEDIAITEM media ON media.Z_PK = m.ZMEDIAITEM
      WHERE m.ZMESSAGETYPE = 3 AND m.Z_PK > ?
        AND media.ZMEDIALOCALPATH IS NOT NULL
        AND media.ZMEDIALOCALPATH <> ''
      ORDER BY m.Z_PK
    `).all(sincePk) as { pk: number; stanza_id: string | null;
      thread_jid: string; relative_path: string }[];
    return rows.filter((r) => isRealChat(r.thread_jid)).map((r) => ({
      message_id: `${r.thread_jid}:${r.stanza_id || `pk-${r.pk}`}`,
      thread_id: r.thread_jid,
      source_pk: Number(r.pk),
      relative_path: String(r.relative_path),
    }));
  } finally {
    db.close();
  }
}

/**
 * Group titles, which do not live on ZWACHATSESSION.ZPARTNERNAME reliably.
 * Returns jid -> subject for every group the store knows about.
 */
export function groupTitles(snapshotPath: string): Map<string, string> {
  const db = openSourceRO(snapshotPath);
  try {
    const out = new Map<string, string>();
    for (const r of db
      .prepare(
        `SELECT c.ZCONTACTJID j, c.ZPARTNERNAME n FROM ZWACHATSESSION c
         WHERE c.ZCONTACTJID LIKE '%@g.us' AND c.ZPARTNERNAME IS NOT NULL`,
      )
      .all() as any[]) {
      out.set(String(r.j), String(r.n));
    }
    return out;
  } finally {
    db.close();
  }
}

/** Does this message contribute text to the index? */
export function isTexty(m: RawMessage): boolean {
  return !!m.text && m.text.trim() !== '';
}

export function messageKind(msgType: number): string {
  switch (msgType) {
    case 0: return 'text';
    case 1: return 'image';
    case 2: return 'video';
    case 3: return 'audio';
    case 4: return 'contact';
    case 5: return 'location';
    case 7: return 'link';
    case 8: return 'document';
    case 11: return 'sticker';
    case 14: return 'poll';
    case 15: return 'system';
    default: return `type_${msgType}`;
  }
}

/** Highest Z_PK in a snapshot — the watermark to store after a run. */
export function maxPk(snapshotPath: string): number {
  const db = openSourceRO(snapshotPath);
  try {
    const row = db.prepare('SELECT MAX(Z_PK) m FROM ZWAMESSAGE').get() as any;
    return Number(row?.m ?? 0);
  } finally {
    db.close();
  }
}

/** Total messages in the source, for freshness comparison against the archive. */
export function sourceCounts(snapshotPath: string): { messages: number; maxPk: number } {
  const db = openSourceRO(snapshotPath);
  try {
    const row = db
      .prepare('SELECT COUNT(*) c, MAX(Z_PK) m FROM ZWAMESSAGE')
      .get() as any;
    return { messages: Number(row?.c ?? 0), maxPk: Number(row?.m ?? 0) };
  } finally {
    db.close();
  }
}
