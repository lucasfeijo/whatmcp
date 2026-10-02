import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openStore } from '../src/db/index.ts';
import { buildServer } from '../src/mcp/tools.ts';
import { invalidate, getStore } from '../src/store.ts';

test('message feed pages every message across tied timestamps without a query or API key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-feed-'));
  const handles = new Set<ReturnType<typeof getStore>>();
  t.after(() => {
    invalidate();
    for (const h of handles) { try { h.db.close(); } catch { /* already closed */ } }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'archive.db');
  const db = openStore(path);
  const thread = db.prepare(`INSERT INTO threads
    (id, title, kind, first_seen_at, last_seen_at) VALUES (?, ?, 'dm', 0, 0)`);
  thread.run('a', 'Ana');
  thread.run('b', 'Beto');
  const message = db.prepare(`INSERT INTO messages
    (id, thread_id, ts, text, kind, is_from_me, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 0)`);
  message.run('a:1', 'a', 100, 'before', 'text', 0);
  message.run('b:1', 'b', 101, 'first', 'text', 0);
  message.run('a:2', 'a', 101, 'second', 'text', 1);
  message.run('a:3', 'a', 101, null, 'image', 0);
  message.run('b:2', 'b', 102, 'last', 'text', 0);
  message.run('b:3', 'b', 103, 'outside', 'text', 0);

  const server = buildServer({
    cfg: {
      store: path, chatstorage: '/nonexistent', openaiKey: null,
      openaiModel: 'text-embedding-3-small', openaiDims: 1536,
      syncIntervalHours: 0,
    },
    embedCfg: null, keyError: 'not configured', allowSync: false,
  });
  const client = new Client({ name: 'feed-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const read = async (args: Record<string, unknown>) => {
    handles.add(getStore(path, 'openai/text-embedding-3-small@1536'));
    const result = await client.callTool({ name: 'list_messages_since', arguments: args });
    return (result.content as { type: string; text: string }[])[0].text;
  };
  const ids: string[] = [];
  let args: Record<string, unknown> = {
    after: '1970-01-01T00:01:41Z', before: '1970-01-01T00:01:42Z', limit: 2,
  };
  for (;;) {
    const page = await read(args);
    ids.push(...[...page.matchAll(/message_id: ([^ |]+)/g)].map(m => m[1]));
    const next = page.match(/next_cursor: ([A-Za-z0-9_-]+)/)?.[1];
    if (!next) { assert.match(page, /has_more: false/); break; }
    assert.match(page, /has_more: true/);
    args = { cursor: next, limit: 2 };
  }
  assert.deepEqual(ids, ['a:2', 'a:3', 'b:1', 'b:2']);
  assert.match(await read({ after: '1970-01-01T00:01:41Z', before: '1970-01-01T00:01:42Z', thread_id: 'a' }), /message_id: a:3/);
  assert.doesNotMatch(await read({ after: '1970-01-01T00:01:41Z', before: '1970-01-01T00:01:42Z', thread_id: 'a' }), /message_id: b:1/);
  assert.match(await read({ after: '1970-01-01T00:01:41Z', before: '1970-01-01T00:01:42Z' }), /<image>/);
});
