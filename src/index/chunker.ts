/**
 * Conversation windowing — the core retrieval decision in WhatMCP.
 *
 * Individual chat messages are close to useless as retrieval units. A large
 * fraction of any real history looks like this:
 *
 *     Alex:   nope
 *     Sam:    anyone have the link for tomorrow
 *
 * "nope" carries no standalone meaning — not for BM25, and emphatically not for
 * an embedding model. The signal lives in the burst, not in the message.
 *
 * So messages are grouped into windows: consecutive messages in one thread with no
 * silence longer than gapSeconds, rendered with speaker labels. Windows are capped
 * so one busy group chat cannot produce a single enormous blob. On a real corpus
 * this collapses ~41k text messages into ~5k coherent, self-contained units.
 */

import { createHash } from 'node:crypto';

export interface ChunkInput {
  message_id: string;
  thread_id: string;
  sender_name: string | null;
  ts: number;
  text: string;
  part_no?: number;
}

export interface Window {
  thread_id: string;
  start_ts: number;
  end_ts: number;
  msg_count: number;
  speakers: string;
  text: string;
  first_msg_id: string;
  last_msg_id: string;
  parts: { message_id: string; part_no: number }[];
}

export interface ChunkOptions {
  /** Silence longer than this starts a new window. */
  gapSeconds?: number;
  /** Hard cap on messages per window. */
  maxMessages?: number;
  /** Hard cap on rendered characters per window. */
  maxChars?: number;
}

export const DEFAULTS: Required<ChunkOptions> = {
  gapSeconds: 1800, // 30 minutes
  maxMessages: 40,
  maxChars: 4000,
};

/**
 * Stable identity for a window's *content*, used to key embeddings.
 *
 * Hashes exactly the payload that gets embedded — thread, speakers, rendered text.
 * Timestamps are deliberately excluded: two windows with identical text and
 * speakers in the same thread are semantically identical, so sharing one vector is
 * correct and yields free deduplication.
 *
 * The \x1f (unit separator) delimiter is not decorative. thread_id contains '@'
 * and '.', speakers is comma-joined, and any printable delimiter would leave field
 * boundaries forgeable — two genuinely different windows could hash identically.
 */
export function windowHash(w: { thread_id: string; speakers: string; text: string }): string {
  return createHash('sha256')
    .update(w.thread_id).update('\x1f')
    .update(w.speakers ?? '').update('\x1f')
    .update(w.text)
    .digest('hex');
}

/**
 * Group messages into conversation windows.
 * Input need not be sorted; it is sorted by (thread, ts, message id, part).
 */
export function chunk(messages: ChunkInput[], opts: ChunkOptions = {}): Window[] {
  const { gapSeconds, maxMessages, maxChars } = { ...DEFAULTS, ...opts };

  // Split before windowing: one long transcript must never bypass maxChars.
  const pieces = messages.flatMap((m) => {
    const allowance = Math.max(128, maxChars - (m.sender_name?.length ?? 7) - 3);
    if (m.text.length <= allowance) return [{ ...m, part_no: m.part_no ?? 0 }];
    const out: ChunkInput[] = [];
    let rest = m.text.trim();
    let part = m.part_no ?? 0;
    while (rest.length > allowance) {
      let cut = rest.lastIndexOf(' ', allowance);
      if (cut < allowance / 2) cut = allowance;
      out.push({ ...m, text: rest.slice(0, cut).trim(), part_no: part++ });
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push({ ...m, text: rest, part_no: part });
    return out;
  });
  const sorted = pieces.sort(
    (a, b) => a.thread_id.localeCompare(b.thread_id) || a.ts - b.ts ||
      a.message_id.localeCompare(b.message_id) || (a.part_no ?? 0) - (b.part_no ?? 0),
  );

  const windows: Window[] = [];
  let buf: ChunkInput[] = [];
  let runningChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const speakers = [...new Set(buf.map((m) => m.sender_name ?? 'unknown'))];
    windows.push({
      thread_id: buf[0].thread_id,
      start_ts: buf[0].ts,
      end_ts: buf[buf.length - 1].ts,
      msg_count: new Set(buf.map((m) => m.message_id)).size,
      speakers: speakers.join(', '),
      text: render(buf),
      first_msg_id: buf[0].message_id,
      last_msg_id: buf[buf.length - 1].message_id,
      parts: buf.map((m) => ({ message_id: m.message_id, part_no: m.part_no ?? 0 })),
    });
    buf = [];
    runningChars = 0;
  };

  for (const m of sorted) {
    if (buf.length > 0) {
      const prev = buf[buf.length - 1];
      const broke =
        m.thread_id !== prev.thread_id ||
        m.ts - prev.ts > gapSeconds ||
        buf.length >= maxMessages ||
        runningChars + m.text.length + (m.sender_name?.length ?? 7) + 2 > maxChars;
      if (broke) flush();
    }
    buf.push(m);
    runningChars += m.text.length + (m.sender_name?.length ?? 0) + 3;
  }
  flush();

  return windows;
}

/**
 * Collapse consecutive messages from one speaker onto a single label, the way a
 * person reading the transcript would. Keeps windows compact without losing turns.
 */
function render(msgs: ChunkInput[]): string {
  const lines: string[] = [];
  let lastSpeaker: string | null = null;

  for (const m of msgs) {
    const speaker = m.sender_name ?? 'unknown';
    const body = m.text.replace(/\s*\n\s*/g, ' ').trim();
    if (speaker === lastSpeaker) {
      lines[lines.length - 1] += ` ${body}`;
    } else {
      lines.push(`${speaker}: ${body}`);
      lastSpeaker = speaker;
    }
  }
  return lines.join('\n');
}
