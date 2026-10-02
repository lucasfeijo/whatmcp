/**
 * Retrieval over conversation windows.
 *
 * Hybrid: BM25 (FTS5) fused with dense vectors by rank. Neither arm suffices
 * alone — BM25 owns names, numbers, and the texting shorthand the encoder never
 * saw ("idk", "ttyl", "lmk" subword-shatter into noise); vectors own paraphrase
 * and cross-lingual recall, so a question asked in one language can find a
 * conversation held in another. Metadata filters apply to both arms.
 *
 * The contract is retrieval-to-*navigate*, not retrieval-to-answer: search returns
 * windows with ids, and getConversation() expands any of them into the full
 * surrounding transcript. The model does the reasoning.
 */

import type { DB } from '../db/index.ts';
import { getStore } from '../store.ts';
import { topKCosine, fuseRRF } from './vectors.ts';
import { embed as apiEmbed, modelTag, type EmbedConfig } from '../index/openai.ts';

export interface SearchParams {
  query: string;
  thread?: string; // substring match on chat title
  sender?: string; // substring match on speaker names
  after?: number;  // unix seconds
  before?: number;
  limit?: number;
}

export type SearchMode = 'hybrid' | 'bm25' | 'vector';

export interface HybridParams extends SearchParams {
  mode?: SearchMode;
  topK?: number;  // per-arm candidate depth before fusion
  rrfK?: number;
  wBm25?: number;
  wVec?: number;
  minSim?: number;
  strongSim?: number;
}

/**
 * Thresholds for the vector arm.
 *
 * These are NOT universal constants — they are specific to the embedding model,
 * and copying them from another project is how semantic search silently breaks.
 * E5-family models put unrelated text around 0.70–0.80 cosine, so a 0.80 floor is
 * reasonable there. text-embedding-3-small is spread far wider: unrelated pairs
 * sit near 0.05–0.20 and genuinely relevant ones near 0.35–0.60. Applying E5's
 * floor here would reject every result the vector arm ever produced, leaving
 * keyword-only search that still *looks* like it is working.
 *
 * The defaults below are starting points measured against this corpus by
 * `npm run wa -- calibrate`, which writes the fitted values into config.json.
 * Treat them as calibration output, not as truths.
 */
export const DEFAULT_MIN_SIM = 0.18;

/**
 * Similarity at which a vector hit counts as evidence *on its own*.
 *
 * The important lesson, from measuring this on a real multi-language corpus:
 * cosine similarity does not separate relevant from irrelevant in absolute terms
 * across queries. A genuine cross-language question can score below outright
 * nonsense, because both are "far from everything". Any single threshold that
 * blocks the nonsense also blocks the cross-language questions that are one of
 * the main reasons to have embeddings at all.
 *
 * So relevance is not decided by a threshold. Results are RETURNED but LABELLED: a
 * hit is "strong" when BM25 corroborates it, or when its similarity is high enough
 * that essentially only genuine matches reach it. Search then reports how much of
 * what it found is corroborated, and the reading model decides — instead of being
 * silently handed noise, or silently denied real answers.
 */
export const DEFAULT_STRONG_SIM = 0.42;

export interface Hit {
  window_id: number;
  thread_id: string;
  thread_title: string | null;
  thread_kind: string;
  start_ts: number;
  end_ts: number;
  speakers: string;
  msg_count: number;
  text: string;
  score: number;
  /** Provenance — free to carry, and the only way to debug or evaluate fusion. */
  bm25_rank?: number | null;
  vec_rank?: number | null;
  vec_sim?: number | null;
  /** Real evidence, or merely the closest available text? */
  strong?: boolean;
  term_coverage?: number;
}

/**
 * Stopwords for the BM25 arm.
 *
 * English plus one additional language ship by default, because a stopword list
 * only helps for languages it covers and most archives are not monolingual. The
 * rest of the arm is language-agnostic: FTS5 tokenizes by Unicode rules, so
 * search works in any language whether or not its function words are listed here.
 * Add your own below if a language you use is over-matching.
 *
 * Motivated by measurement rather than tidiness: without this, BM25 answers every
 * query, because ORing every term means "did anyone say something about the
 * money I lent" matches any window containing "say". That garbage then enters
 * rank fusion as though it were signal. With the vector arm covering recall, the
 * BM25 arm should get *more* precise, not less.
 */
const STOPWORDS = new Set([
  // Additional-language function words (see note above).
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
  'em', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'por', 'para', 'pra', 'pro', 'com',
  'sem', 'sobre', 'entre', 'que', 'quem', 'qual', 'quais', 'quando', 'onde', 'como',
  'porque', 'se', 'e', 'ou', 'mas', 'nao', 'não', 'sim', 'ja', 'já', 'foi', 'ser',
  'sao', 'são', 'esta', 'está', 'estao', 'estão', 'tem', 'ter', 'tinha', 'vai',
  'vou', 'eu', 'voce', 'você', 'ele', 'ela', 'eles', 'elas', 'nós', 'meu', 'minha',
  'seu', 'sua', 'isso', 'isto', 'aquilo', 'esse', 'essa', 'este', 'algum', 'alguma',
  'alguem', 'alguém', 'muito', 'mais', 'menos', 'tudo', 'todo', 'toda', 'todos',
  'todas', 'fazer', 'falou', 'falar', 'disse', 'dizer',
  // English function words.
  'the', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'without', 'about',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'what', 'when', 'where', 'who', 'which',
  'how', 'why', 'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them',
  'their', 'i', 'you', 'he', 'she', 'we', 'my', 'your', 'said', 'say', 'says',
  'some', 'someone', 'anything', 'something', 'people', 'get', 'got', 'make', 'made',
]);

/**
 * FTS5 treats a lot of punctuation as syntax. Users (and models) type questions,
 * not query expressions, so each term is quoted and ORed — precision comes from
 * BM25 ranking and term coverage, not from making the caller learn MATCH syntax.
 */
function toMatchExpr(query: string): string {
  const raw = query
    .replace(/["*()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  const content = raw.filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // Fall back to the unfiltered terms when a query is *entirely* stopwords or
  // single characters ("who?", "5"). Returning nothing there would report a
  // confident "no matches" for a query we merely declined to parse — and would
  // discard the chat/sender/date filters along with it.
  const terms = content.length > 0 ? content : raw;
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t}"`).join(' OR ');
}

function contentTerms(query: string): string[] {
  return query
    .replace(/["*()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Fraction of a query's content terms that actually appear in a window.
 *
 * BM25 here ORs its terms, so a five-word query matches a window containing just
 * one of them. That is fine when the vector arm corroborates the hit and actively
 * harmful when it does not: "quantum chromodynamics lattice gauge theory" matched
 * a window on one stray token and was presented as an answer.
 *
 * Coverage separates the two cases a raw BM25 score cannot. Searching one rare
 * proper noun is one term of one — coverage 1.0, kept. Matching one token of five
 * unrelated ones is 0.2 — dropped.
 */
function termCoverage(text: string, terms: string[]): number {
  if (terms.length === 0) return 1;
  const hay = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (hay.includes(t)) hit++;
  return hit / terms.length;
}

/**
 * Minimum share of query terms a BM25 hit must contain to count as corroborated.
 * Deliberately permissive: this kills 1-of-5 accidents, it does not second-guess
 * BM25 whenever it disagrees with the encoder.
 */
const MIN_BM25_COVERAGE = 0.5;

function filterClauses(p: SearchParams): { sql: string[]; args: any[] } {
  const sql: string[] = [];
  const args: any[] = [];
  if (p.thread) {
    sql.push('t.title LIKE ?');
    args.push(`%${p.thread}%`);
  }
  if (p.sender) {
    sql.push('w.speakers LIKE ?');
    args.push(`%${p.sender}%`);
  }
  /*
   * Overlap, not containment. A window is an interval: requiring
   * start_ts >= after AND end_ts <= before drops any burst straddling either edge,
   * so a conversation running 23:50–00:20 vanishes from a search for "after
   * July 1" even though it contains July 1 messages. Silent recall loss, no error.
   */
  if (p.after !== undefined) {
    sql.push('w.end_ts >= ?');
    args.push(p.after);
  }
  if (p.before !== undefined) {
    sql.push('w.start_ts <= ?');
    args.push(p.before);
  }
  return { sql, args };
}

/**
 * Resolve metadata filters to a bitmap of permitted window_ids.
 *
 * Returns null when nothing is filtered, which the vector scan reads as
 * "everything" — materializing every id for an unfiltered query is pure waste.
 *
 * A byte-per-id Uint8Array rather than a Set: a few KB at this scale, and the
 * indexed load in the scan loop beats a hash probe.
 */
function allowedBitmap(db: DB, p: SearchParams, maxWindowId: number): Uint8Array | null {
  const { sql, args } = filterClauses(p);
  if (sql.length === 0) return null;

  const bitmap = new Uint8Array(maxWindowId + 1);
  const rows = db
    .prepare(`SELECT w.id FROM windows w JOIN threads t ON t.id = w.thread_id
              WHERE ${sql.join(' AND ')}`)
    .all(...args) as { id: number }[];
  for (const r of rows) if (r.id <= maxWindowId) bitmap[r.id] = 1;
  return bitmap;
}

function bm25Arm(db: DB, p: SearchParams, topK: number): { id: number; text: string }[] {
  const match = toMatchExpr(p.query);
  if (!match) return [];

  const { sql, args } = filterClauses(p);
  return db
    .prepare(`
      SELECT w.id AS id, w.text AS text
      FROM windows_fts
      JOIN windows w ON w.id = windows_fts.rowid
      JOIN threads t ON t.id = w.thread_id
      WHERE windows_fts MATCH ?${sql.length ? ' AND ' + sql.join(' AND ') : ''}
      ORDER BY bm25(windows_fts, 1.0, 0.5)
      LIMIT ?
    `)
    .all(match, ...args, topK) as { id: number; text: string }[];
}

export interface SearchContext {
  storePath: string;
  embedCfg: EmbedConfig;
}

/** Embed one query. Isolated so search can degrade to BM25 if the API is down. */
async function embedQuery(cfg: EmbedConfig, text: string): Promise<Float32Array> {
  const { vectors } = await apiEmbed(cfg, [text]);
  return vectors[0];
}

/**
 * Hybrid search: BM25 and dense vectors, fused by rank.
 *
 * Degrades rather than failing in two directions: an archive with no vectors for
 * the active model falls back to BM25, and so does an unreachable embeddings API.
 * Both cases are reported through `degraded`, because silently answering a
 * semantic question with keyword-only results is exactly the kind of quiet
 * quality loss this project is trying to avoid.
 */
export interface SearchOutcome {
  hits: Hit[];
  degraded: string | null;
  strongCount: number;
}

export async function searchHybrid(ctx: SearchContext, p: HybridParams): Promise<SearchOutcome> {
  const mode = p.mode ?? 'hybrid';
  const topK = p.topK ?? 120;
  const limit = p.limit ?? 10;
  const tag = modelTag(ctx.embedCfg);
  const store = getStore(ctx.storePath, tag);
  const db = store.db;

  let degraded: string | null = null;
  const ix = mode === 'bm25' ? null : store.vectors;
  if (!ix && mode !== 'bm25') {
    degraded =
      'No vectors for this embedding model in the archive — searched by keyword only. ' +
      'Run `npm run wa -- embed` to enable semantic search.';
    if (mode === 'vector') return { hits: [], degraded, strongCount: 0 };
  }

  const bm25Raw = mode === 'vector' ? [] : bm25Arm(db, p, topK);

  let vecHits: { window_id: number; sim: number }[] = [];
  if (ix && mode !== 'bm25') {
    try {
      const q = await embedQuery(ctx.embedCfg, p.query);
      const allowed = allowedBitmap(db, p, ix.maxWindowId);
      vecHits = topKCosine(ix, q, topK, allowed, p.minSim ?? DEFAULT_MIN_SIM);
    } catch (e) {
      degraded =
        `Could not embed the query (${(e as Error).message}) — searched by keyword only.`;
      if (mode === 'vector') return { hits: [], degraded, strongCount: 0 };
    }
  }
  const vecIds = vecHits.map((h) => h.window_id);

  const terms = contentTerms(p.query);
  const coverage = new Map(bm25Raw.map((r) => [r.id, termCoverage(r.text, terms)]));
  const bm25Ids = bm25Raw.map((r) => r.id);

  const arms = [
    { ids: bm25Ids, weight: p.wBm25 ?? 1.0 },
    { ids: vecIds, weight: p.wVec ?? 0.9 },
  ];
  const useFusion = mode === 'hybrid' && vecIds.length > 0 && bm25Ids.length > 0;
  const fusedScore = useFusion ? fuseRRF(arms, p.rrfK ?? 20) : null;

  let ordered: number[];
  if (mode === 'bm25') ordered = bm25Ids.slice(0, limit);
  else if (mode === 'vector') ordered = vecIds.slice(0, limit);
  else if (fusedScore) {
    ordered = [...fusedScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);
  } else {
    // Exactly one arm produced anything; use it directly rather than running RRF
    // over a single list, which would just reproduce that list at extra cost.
    ordered = (vecIds.length ? vecIds : bm25Ids).slice(0, limit);
  }
  if (ordered.length === 0) return { hits: [], degraded, strongCount: 0 };

  const bm25Rank = new Map(bm25Ids.map((id, i) => [id, i + 1]));
  const vecRank = new Map(vecIds.map((id, i) => [id, i + 1]));
  const simOf = new Map(vecHits.map((h) => [h.window_id, h.sim]));
  const strongSim = p.strongSim ?? DEFAULT_STRONG_SIM;

  // One round trip for the payload, then reorder in JS — SQL will not preserve
  // the fused ordering through an IN clause.
  const rows = db
    .prepare(`
      SELECT w.id AS window_id, w.thread_id, t.title AS thread_title, t.kind AS thread_kind,
             w.start_ts, w.end_ts, w.speakers, w.msg_count, w.text
      FROM windows w JOIN threads t ON t.id = w.thread_id
      WHERE w.id IN (${ordered.map(() => '?').join(',')})
    `)
    .all(...ordered) as any[];

  const byId = new Map(rows.map((r) => [Number(r.window_id), r]));
  const hits = ordered.flatMap((id, i) => {
    const r = byId.get(id);
    if (!r) return [];
    return [{
      ...r,
      score: fusedScore?.get(id) ?? (mode === 'vector' ? (simOf.get(id) ?? 0) : ordered.length - i),
      bm25_rank: bm25Rank.get(id) ?? null,
      vec_rank: vecRank.get(id) ?? null,
      vec_sim: simOf.get(id) ?? null,
      // Evidence, not a score: either the keywords genuinely appear in the text,
      // or similarity is high enough that essentially only real matches reach it.
      strong: (coverage.get(id) ?? 0) >= MIN_BM25_COVERAGE || (simOf.get(id) ?? 0) >= strongSim,
      term_coverage: coverage.get(id) ?? 0,
    } as Hit];
  });

  return { hits, degraded, strongCount: hits.filter((h) => h.strong).length };
}

// --- conversation ------------------------------------------------------------

export interface ConversationParams {
  thread_id: string;
  around_ts?: number;
  limit?: number;
}

export interface Msg {
  id: string;
  ts: number;
  sender_name: string;
  text: string | null;
  kind: string;
  is_from_me: number;
}

/**
 * Full messages from one thread. With around_ts, returns a balanced window
 * centred on that moment — the expansion path from a search hit.
 */
export function getConversation(ctx: SearchContext, p: ConversationParams): Msg[] {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const limit = p.limit ?? 50;
  const sel = `
    SELECT m.id, m.ts, m.text, m.kind, m.is_from_me,
           CASE WHEN m.is_from_me = 1 THEN 'me'
                ELSE COALESCE(s.display_name, s.id, 'unknown') END AS sender_name
    FROM messages m
    LEFT JOIN senders s ON s.id = m.sender_id
    WHERE m.thread_id = ?
  `;

  if (p.around_ts === undefined) {
    const rows = db
      .prepare(`${sel} ORDER BY m.ts DESC, m.id DESC LIMIT ?`)
      .all(p.thread_id, limit) as any[];
    return rows.reverse() as Msg[];
  }

  /*
   * Split on (ts, id), not ts alone. A meaningful share of messages share a
   * (thread, ts) with another — bursts sent in the same second — and search hands
   * the model exactly a window's start_ts to centre on. Splitting on ts alone puts
   * an entire tied burst in the `before` bucket, which then returns an arbitrary
   * half of it with zero preceding context, and no value of `around` recovers the
   * rest. The id tiebreaker also pins the within-tie order, which SQL leaves
   * unspecified.
   */
  const half = Math.floor(limit / 2);
  const pivot = db
    .prepare('SELECT MAX(m.id) AS id FROM messages m WHERE m.thread_id = ? AND m.ts <= ?')
    .get(p.thread_id, p.around_ts) as { id: string | null };

  const before = db
    .prepare(`${sel} AND (m.ts < ? OR (m.ts = ? AND m.id <= ?))
              ORDER BY m.ts DESC, m.id DESC LIMIT ?`)
    .all(p.thread_id, p.around_ts, p.around_ts, pivot.id ?? '', half) as any[];

  const after = db
    .prepare(`${sel} AND (m.ts > ? OR (m.ts = ? AND m.id > ?))
              ORDER BY m.ts ASC, m.id ASC LIMIT ?`)
    .all(p.thread_id, p.around_ts, p.around_ts, pivot.id ?? '', limit - half) as any[];

  return [...before.reverse(), ...after] as Msg[];
}

// --- chronological message feed ---------------------------------------------

export interface MessageFeedParams {
  after: number;
  before: number;
  thread_id?: string;
  limit: number;
  last?: { ts: number; id: string };
}

export interface FeedMessage extends Msg {
  thread_id: string;
  thread_title: string | null;
  thread_kind: string;
}

/**
 * Enumerate individual archived messages without retrieval ranking or embeddings.
 * The (ts, id) keyset includes every tied timestamp exactly once across pages.
 * Fetch one extra row so the caller can distinguish completion from a full page.
 */
export function listMessageFeed(
  ctx: SearchContext,
  p: MessageFeedParams,
): { messages: FeedMessage[]; hasMore: boolean } {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const rows = db.prepare(`
    SELECT m.id, m.thread_id, t.title AS thread_title, t.kind AS thread_kind,
           m.ts, m.text, m.kind, m.is_from_me,
           CASE WHEN m.is_from_me = 1 THEN 'me'
                ELSE COALESCE(s.display_name, s.id, 'unknown') END AS sender_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    LEFT JOIN senders s ON s.id = m.sender_id
    WHERE m.ts >= ? AND m.ts <= ?
      ${p.thread_id ? 'AND m.thread_id = ?' : ''}
      ${p.last ? 'AND (m.ts, m.id) > (?, ?)' : ''}
    ORDER BY m.ts ASC, m.id ASC
    LIMIT ?
  `).all(
    p.after, p.before,
    ...(p.thread_id ? [p.thread_id] : []),
    ...(p.last ? [p.last.ts, p.last.id] : []),
    p.limit + 1,
  ) as FeedMessage[];
  return { messages: rows.slice(0, p.limit), hasMore: rows.length > p.limit };
}

// --- chats, people, timeline -------------------------------------------------

export interface Thread {
  id: string;
  title: string | null;
  kind: string;
  msg_count: number;
  first_ts: number;
  last_ts: number;
}

export function listThreads(
  ctx: SearchContext,
  p: { query?: string; kind?: 'dm' | 'group'; limit?: number } = {},
): Thread[] {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const where: string[] = ['msg_count > 0'];
  const args: any[] = [];
  if (p.query) {
    where.push('(title LIKE ? OR id LIKE ?)');
    args.push(`%${p.query}%`, `%${p.query}%`);
  }
  if (p.kind) {
    where.push('kind = ?');
    args.push(p.kind);
  }
  return db
    .prepare(`
      SELECT id, title, kind, msg_count, first_ts, last_ts
      FROM threads WHERE ${where.join(' AND ')}
      ORDER BY last_ts DESC LIMIT ?
    `)
    .all(...args, p.limit ?? 50) as Thread[];
}

export interface Person {
  sender_id: string;
  display_name: string | null;
  phone: string | null;
  msg_count: number;
  thread_count: number;
  first_ts: number;
  last_ts: number;
  top_threads: string | null;
}

/**
 * Resolve a name to the people and chats it matches.
 *
 * Without this, person-scoped questions are guesswork: the model has to guess how
 * a name is spelled in the archive ("Sam" vs "Sam Rivera" vs a bare @lid) before
 * it can filter by sender. This turns that guess into a lookup.
 */
export function listPeople(
  ctx: SearchContext,
  p: { query?: string; limit?: number } = {},
): Person[] {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const where = p.query ? 'WHERE (s.display_name LIKE ? OR s.id LIKE ? OR s.phone LIKE ?)' : '';
  const args = p.query ? [`%${p.query}%`, `%${p.query}%`, `%${p.query}%`] : [];

  return db
    .prepare(`
      SELECT s.id AS sender_id, s.display_name, s.phone,
             COUNT(m.id) AS msg_count,
             COUNT(DISTINCT m.thread_id) AS thread_count,
             MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts,
             (SELECT GROUP_CONCAT(title, ' | ') FROM (
                SELECT t2.title AS title FROM messages m2
                JOIN threads t2 ON t2.id = m2.thread_id
                WHERE m2.sender_id = s.id AND t2.title IS NOT NULL
                GROUP BY t2.id ORDER BY COUNT(*) DESC LIMIT 3
             )) AS top_threads
      FROM senders s
      JOIN messages m ON m.sender_id = s.id
      ${where}
      GROUP BY s.id
      HAVING msg_count > 0
      ORDER BY msg_count DESC
      LIMIT ?
    `)
    .all(...args, p.limit ?? 25) as Person[];
}

export interface TimelineBucket {
  period: string;
  messages: number;
}

/**
 * Message volume over time, optionally scoped by keyword, person, or chat.
 * Answers "when did this start" and "when were we talking most" without dragging
 * thousands of messages through the model's context to count them.
 */
export function getTimeline(
  ctx: SearchContext,
  p: {
    query?: string;
    thread?: string;
    sender?: string;
    granularity?: 'day' | 'week' | 'month' | 'year';
    limit?: number;
  } = {},
): TimelineBucket[] {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const fmt =
    p.granularity === 'day' ? '%Y-%m-%d'
    : p.granularity === 'week' ? '%Y-W%W'
    : p.granularity === 'year' ? '%Y'
    : '%Y-%m';

  const where: string[] = ['m.text IS NOT NULL'];
  const args: any[] = [];
  if (p.query) {
    where.push('m.text LIKE ?');
    args.push(`%${p.query}%`);
  }
  if (p.thread) {
    where.push('t.title LIKE ?');
    args.push(`%${p.thread}%`);
  }
  if (p.sender) {
    where.push("(s.display_name LIKE ? OR (m.is_from_me = 1 AND 'me' LIKE ?))");
    args.push(`%${p.sender}%`, `%${p.sender}%`);
  }

  return db
    .prepare(`
      SELECT strftime('${fmt}', m.ts, 'unixepoch') AS period, COUNT(*) AS messages
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      LEFT JOIN senders s ON s.id = m.sender_id
      WHERE ${where.join(' AND ')}
      GROUP BY period ORDER BY period DESC LIMIT ?
    `)
    .all(...args, p.limit ?? 36) as TimelineBucket[];
}

export interface ThreadSummary {
  thread: Thread;
  participants: { name: string; msg_count: number }[];
  busiest_period: string | null;
  window_count: number;
}

/** Shape of one chat: who talks in it, how much, and when it peaked. */
export function getThreadSummary(ctx: SearchContext, threadId: string): ThreadSummary | null {
  const db = getStore(ctx.storePath, modelTag(ctx.embedCfg)).db;
  const thread = db
    .prepare('SELECT id, title, kind, msg_count, first_ts, last_ts FROM threads WHERE id = ?')
    .get(threadId) as Thread | undefined;
  if (!thread) return null;

  const participants = db
    .prepare(`
      SELECT CASE WHEN m.is_from_me = 1 THEN 'me'
                  ELSE COALESCE(s.display_name, s.id, 'unknown') END AS name,
             COUNT(*) AS msg_count
      FROM messages m
      LEFT JOIN senders s ON s.id = m.sender_id
      WHERE m.thread_id = ?
      GROUP BY name ORDER BY msg_count DESC LIMIT 30
    `)
    .all(threadId) as { name: string; msg_count: number }[];

  const busiest = db
    .prepare(`
      SELECT strftime('%Y-%m', ts, 'unixepoch') AS period, COUNT(*) c
      FROM messages WHERE thread_id = ? GROUP BY period ORDER BY c DESC LIMIT 1
    `)
    .get(threadId) as { period: string } | undefined;

  const windows = db
    .prepare('SELECT COUNT(*) c FROM windows WHERE thread_id = ?')
    .get(threadId) as { c: number };

  return {
    thread,
    participants,
    busiest_period: busiest?.period ?? null,
    window_count: Number(windows.c),
  };
}

export interface Stats {
  messages: number;
  threads: number;
  senders: number;
  windows: number;
  embedded: number;
  model: string;
  earliest: number;
  latest: number;
  last_sync_at: number;
  watermark: number;
}

export function stats(ctx: SearchContext): Stats {
  const tag = modelTag(ctx.embedCfg);
  const db = getStore(ctx.storePath, tag).db;
  const one = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as any)?.v ?? 0);
  return {
    messages: one('SELECT COUNT(*) v FROM messages'),
    threads: one('SELECT COUNT(*) v FROM threads WHERE msg_count > 0'),
    senders: one('SELECT COUNT(*) v FROM senders'),
    windows: one('SELECT COUNT(*) v FROM windows'),
    embedded: one(
      `SELECT COUNT(*) v FROM windows w
       JOIN window_vectors x ON x.content_hash = w.content_hash AND x.model = ?`,
      tag,
    ),
    model: tag,
    earliest: one('SELECT MIN(ts) v FROM messages'),
    latest: one('SELECT MAX(ts) v FROM messages'),
    last_sync_at: one("SELECT MAX(last_run_at) v FROM sync_state WHERE id IN ('whatsapp', 'windows-waren6')"),
    watermark: one('SELECT last_source_pk v FROM sync_state WHERE id = \'whatsapp\''),
  };
}
