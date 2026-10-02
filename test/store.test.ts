import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openStore } from '../src/db/index.ts';
import { modelTag } from '../src/index/openai.ts';
import { buildServer } from '../src/mcp/tools.ts';
import { searchHybrid, stats } from '../src/search/search.ts';
import { getStore, invalidate, type Store } from '../src/store.ts';

const embedCfg = { model: 'synthetic-test', dimensions: 4, apiKey: '' };
const tag = modelTag(embedCfg);

async function fixture(fn: (f: ReturnType<typeof createFixture>) => unknown) {
  const f = createFixture();
  try { await fn(f); }
  finally {
    invalidate();
    for (const store of f.handles) {
      try { store.db.close(); } catch { /* already closed */ }
    }
    f.writer.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
}

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-store-test-'));
  const path = join(dir, 'archive.db');
  const writer = openStore(path);
  writer.exec(`
    PRAGMA wal_autocheckpoint = 0;
    INSERT INTO threads (id, kind, first_seen_at, last_seen_at)
      VALUES ('synthetic', 'dm', 1, 1);
    INSERT INTO windows (thread_id, start_ts, end_ts, msg_count, text, content_hash)
      VALUES ('synthetic', 1, 1, 1, 'synthetic fixture', 'fixture-hash');
  `);
  const handles = new Set<Store>();
  return {
    dir, path, writer, handles,
    ctx: { storePath: path, embedCfg },
    get() {
      const store = getStore(path, tag);
      handles.add(store);
      return store;
    },
    vector(bytes = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer)) {
      writer.prepare(`INSERT OR REPLACE INTO window_vectors
        (content_hash, model, dim, created_at, vec) VALUES (?, ?, 4, 1, ?)`)
        .run('fixture-hash', tag, bytes);
    },
  };
}

test('SQL status and BM25 do not load malformed semantic vectors', async () => {
  await fixture(async (f) => {
    f.vector(new Uint8Array(1));
    const store = f.get();
    assert.equal(stats(f.ctx).embedded, 1);
    const result = await searchHybrid(f.ctx, { query: 'absent', mode: 'bm25' });
    assert.deepEqual(result.hits, []);
    assert.throws(() => store.vectors, /vector is 1 bytes/);
    assert.equal(stats(f.ctx).windows, 1, 'a vector error must not break SQL tools');
  });
});

test('loaded vectors and an empty vector index are cached', async () => {
  await fixture((f) => {
    const empty = f.get();
    assert.equal(empty.vectors, null);
    empty.db.close();
    assert.equal(empty.vectors, null, 'cached null must not issue another query');
    invalidate();
    f.vector();
    const loaded = f.get();
    const vectors = loaded.vectors;
    assert.equal(vectors?.n, 1);
    loaded.db.close();
    assert.strictEqual(loaded.vectors, vectors);
  });
});

test('WAL writes and main database changes invalidate vector caches', async () => {
  await fixture((f) => {
    const empty = f.get();
    assert.equal(empty.vectors, null);
    const before = statSync(f.path);
    f.vector();
    assert.equal(statSync(f.path).mtimeMs, before.mtimeMs, 'write remains in WAL');
    const updated = f.get();
    assert.notStrictEqual(updated, empty);
    assert.equal(updated.vectors?.n, 1);
    const oldVectors = updated.vectors;
    f.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Force a distinct main-file timestamp even on coarse-resolution filesystems.
    utimesSync(f.path, before.atime, new Date(before.mtimeMs + 2000));
    const checkpointed = f.get();
    assert.notStrictEqual(checkpointed, updated);
    assert.notStrictEqual(checkpointed.vectors, oldVectors);
    assert.equal(checkpointed.vectors?.n, 1);
  });
});

test('archive status reuses one stats snapshot without loading vectors', async () => {
  await fixture(async (f) => {
    f.vector(new Uint8Array(1));
    const store = f.get();
    const originalPrepare = store.db.prepare.bind(store.db);
    let messageCounts = 0;
    store.db.prepare = ((sql: string) => {
      if (sql === 'SELECT COUNT(*) v FROM messages') messageCounts++;
      return originalPrepare(sql);
    }) as typeof store.db.prepare;
    const server = buildServer({
      cfg: {
        store: f.path, chatstorage: '', sourceType: 'windows-waren6',
        windowsWaren6Path: null, windowsOutputDir: f.dir,
        openaiKey: null, openaiModel: embedCfg.model, openaiDims: 4,
        syncIntervalHours: 0,
      },
      embedCfg: null, keyError: 'synthetic test', allowSync: false,
    });
    const client = new Client({ name: 'store-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'get_archive_status', arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(messageCounts, 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
