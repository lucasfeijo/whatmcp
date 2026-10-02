/**
 * Process-lifetime archive handle with change detection.
 *
 * The obvious implementation opens the database per tool call and closes it in a
 * `finally`. That has nowhere to cache the vector matrix — ~30 MB re-read, parsed
 * and garbage-collected on every request would dominate the ~5 ms the search
 * itself costs.
 *
 * So it caches. Which makes change detection load-bearing: get it wrong and a
 * long-lived MCP server keeps answering from the index as it was when Claude
 * Desktop started, hours after a sync added new messages, with no symptom
 * whatsoever. Keying on (mtime, size) catches an in-place WAL write; keying on
 * inode as well catches a rename-into-place.
 */

import { statSync, existsSync } from 'node:fs';
import { openStoreRO, type DB } from './db/index.ts';
import { loadVectorIndex, type VectorIndex } from './search/vectors.ts';

export interface Store {
  db: DB;
  /** Loaded only when semantic search first requests them. */
  readonly vectors: VectorIndex | null;
  /** Identity of the underlying file; changes when a sync writes to it. */
  key: string;
  model: string;
  loadedAt: number;
}

let current: Store | null = null;

function fileKey(path: string): string {
  const st = statSync(path);
  // The -wal sidecar is where a just-finished sync's data actually lives until a
  // checkpoint folds it back. Ignoring it means a synced-but-uncheckpointed
  // archive looks unchanged and the cached vector index goes stale.
  let walSig = '';
  try {
    const w = statSync(path + '-wal');
    walSig = `${w.size}:${w.mtimeMs}`;
  } catch {
    /* no wal: fully checkpointed */
  }
  return `${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}:${walSig}`;
}

/**
 * Get the archive, reopening if the file changed underneath us.
 *
 * The stat runs on every call and is not throttled: it costs single-digit
 * microseconds against an MCP round trip measured in tens of milliseconds, and
 * throttling would buy nothing while introducing a "stale for up to N seconds"
 * window to reason about.
 */
export function getStore(path: string, modelTag: string): Store {
  const key = fileKey(path);
  if (current && current.key === key && current.model === modelTag) return current;

  const db = openStoreRO(path);
  let vectors: VectorIndex | null = null;
  let vectorsLoaded = false;
  const next: Store = {
    db,
    get vectors() {
      if (!vectorsLoaded) {
        vectors = loadVectorIndex(db, modelTag);
        vectorsLoaded = true;
      }
      return vectors;
    },
    key,
    model: modelTag,
    loadedAt: Date.now(),
  };
  const old = current;
  current = next;

  // Close the previous handle late. Unix keeps an unlinked inode alive until its
  // last descriptor closes, so a request still holding `old` goes on reading a
  // coherent database while new requests get the new one.
  if (old) {
    setTimeout(() => {
      try { old.db.close(); } catch { /* already gone */ }
    }, 30_000).unref();
  }
  return next;
}

/** Like getStore, but null instead of throwing when no archive exists yet. */
export function tryGetStore(path: string, modelTag: string): Store | null {
  if (!existsSync(path)) return null;
  return getStore(path, modelTag);
}

/** Drop the cached handle — used after an in-process sync rewrites the archive. */
export function invalidate(): void {
  const old = current;
  current = null;
  if (old) {
    setTimeout(() => {
      try { old.db.close(); } catch { /* already gone */ }
    }, 30_000).unref();
  }
}
