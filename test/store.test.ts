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

test('index writes invalidate vectors while checkpoints retain the matrix', async () => {
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
    assert.strictEqual(checkpointed.vectors, oldVectors);
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
      const response = JSON.stringify(result);
      assert.match(response, /search:.*ready/);
      assert.doesNotMatch(response, /embedded|embedding|vector|synthetic-test|projection/i);
      const catalog = await client.listTools();
      assert.doesNotMatch(JSON.stringify(catalog.tools.map(tool => tool.description)), /embedding/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test('MCP sync runs the complete worker but only returns public outcomes', async t => {
  const diagnostics: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => diagnostics.push(args.join(' ')));
  await fixture(async f => {
    f.get();
    let exitCode = 0;
    const commands: string[][] = [];
    const server = buildServer({
      cfg: {
        store: f.path, chatstorage: '', sourceType: 'windows-waren6',
        windowsWaren6Path: null, windowsOutputDir: f.dir,
        openaiKey: null, openaiModel: embedCfg.model, openaiDims: 4,
        syncIntervalHours: 0,
      },
      embedCfg: null, keyError: 'synthetic test',
      runSync: async (_command, args, options) => {
        commands.push(args);
        options?.onOutput?.('private-worker-detail: embeddings provider diagnostics');
        return exitCode;
      },
    });
    const client = new Client({ name: 'sync-contract-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const catalog = await client.listTools();
      const sync = catalog.tools.find(tool => tool.name === 'sync_archive')!;
      assert.equal(sync.description, 'Sincroniza o histórico do WhatsApp.');
      assert.deepEqual(Object.keys(sync.inputSchema.properties ?? {}), ['full']);
      assert.equal(sync.annotations?.readOnlyHint, false);
      assert.equal(sync.annotations?.openWorldHint, true);
      for (const full of [false, true]) {
        const result = await client.callTool({ name: 'sync_archive', arguments: { full } });
        f.get(); // Track each cache handle before the next sync invalidates it.
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result), /Sync complete/);
        assert.doesNotMatch(JSON.stringify(result), /private-worker-detail|embedding|provider/i);
        assert.ok(commands.at(-1)?.includes('sync-worker'));
        assert.equal(commands.at(-1)?.includes('--full'), full);
        assert.equal(commands.at(-1)?.includes('--index-only'), false);
      }
      for (const [code, expected] of [[1, /Sync failed/], [75, /already running/], [124, /was stopped/]] as const) {
        exitCode = code;
        const result = await client.callTool({ name: 'sync_archive', arguments: {} });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), expected);
        assert.doesNotMatch(JSON.stringify(result), /private-worker-detail|embedding|provider/i);
      }
      assert.ok(diagnostics.some(line => line.includes('private-worker-detail')));
    } finally {
      await client.close();
      await server.close();
      f.get();
    }
  });
});

 test('progress writes retain an unloaded cache without parsing malformed vectors', async () => {
  await fixture((f) => {
    f.vector(new Uint8Array(1));
    const before = f.get();
    f.writer.exec("INSERT INTO messages(id,thread_id,ts,kind,is_from_me,first_seen_at) VALUES('m','synthetic',1,'audio',0,1)");
    invalidate();
    const after = f.get();
    assert.notEqual(after, before);
    assert.equal(stats(f.ctx).windows, 1);
    assert.throws(() => after.vectors, /vector is 1 bytes/);
  });
});
