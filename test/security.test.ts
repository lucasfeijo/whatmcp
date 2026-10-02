import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openStore } from '../src/db/index.ts';
import { buildServer } from '../src/mcp/tools.ts';
import {
  consentSecurityHeaders,
  FixedWindowLimiter,
  parseRegistration,
} from '../src/mcp/oauth.ts';

test('dynamic client registration bounds and sanitizes persisted metadata', () => {
  assert.deepEqual(
    parseRegistration({
      client_name: 'ChatGPT\nforged log line\u001b[31m\u202ereversed',
      redirect_uris: ['https://chatgpt.com/oauth/callback'],
    }),
    {
      name: 'ChatGPT forged log line [31m reversed',
      redirectUris: ['https://chatgpt.com/oauth/callback'],
    },
  );
  assert.throws(
    () => parseRegistration({ client_name: 'x'.repeat(121), redirect_uris: ['https://a.test/cb'] }),
    /client_name is too long/,
  );
  assert.throws(
    () => parseRegistration({ redirect_uris: ['https://a.test/cb#fragment'] }),
    /must not contain fragments/,
  );
  assert.throws(
    () => parseRegistration({ redirect_uris: Array(11).fill('https://a.test/cb') }),
    /1-10 URLs/,
  );
});

test('registration limiter rejects excess attempts and resets after its window', () => {
  const limiter = new FixedWindowLimiter(2, 100);
  assert.deepEqual(limiter.take('203.0.113.1', 0), { ok: true });
  assert.deepEqual(limiter.take('203.0.113.1', 1), { ok: true });
  assert.deepEqual(limiter.take('203.0.113.1', 2), { ok: false, retryAfterMs: 98 });
  assert.deepEqual(limiter.take('203.0.113.1', 100), { ok: true });
});

test('consent responses deny framing and caching', () => {
  const { redirectOrigin, headers } = consentSecurityHeaders('https://client.example/callback');
  assert.equal(redirectOrigin, 'https://client.example');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /form-action 'self' https:\/\/client\.example/);
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Cache-Control'], 'no-store');
});

async function toolNames(allowSync: boolean | undefined): Promise<string[]> {
  const server = buildServer({
    cfg: {
      store: '/nonexistent/whatmcp-security-test.db',
      chatstorage: '/nonexistent/whatsapp-security-test.db',
      openaiKey: null,
      openaiModel: 'text-embedding-3-small',
      openaiDims: 1536,
      syncIntervalHours: 0,
    },
    embedCfg: null,
    keyError: 'not configured',
    allowSync,
  });
  const client = new Client(
    { name: 'security-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

test('OAuth read-only tool surface omits archive sync', async () => {
  assert.equal((await toolNames(false)).includes('sync_archive'), false);
  assert.equal((await toolNames(undefined)).includes('sync_archive'), true);
});

test('archive databases are forced to owner-only permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-security-'));
  const path = join(dir, 'archive.db');
  try {
    const db = openStore(path);
    db.close();
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set-key reads stdin and refuses credentials in argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-key-'));
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const args = [
    '--experimental-sqlite',
    '--experimental-strip-types',
    '--no-warnings',
    cli,
    'set-key',
  ];
  try {
    const safe = spawnSync(process.execPath, args, {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, WHATMCP_HOME: dir },
      input: 'sk-test-only-not-a-real-secret\n',
      encoding: 'utf8',
    });
    assert.equal(safe.status, 0, safe.stderr);
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(config.openai_api_key, 'sk-test-only-not-a-real-secret');
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
    }

    const rejected = spawnSync(process.execPath, [...args, 'sk-visible-in-argv'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, WHATMCP_HOME: join(dir, 'rejected') },
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /refusing an API key on the command line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((e) => e ? reject(e) : resolve()));
  return port;
}

test('HTTP authentication runs before JSON body parsing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-http-'));
  const port = await freePort();
  const token = 'static-security-test-token-0000000000000000';
  const child = spawn(
    process.execPath,
    [
      '--experimental-sqlite',
      '--experimental-strip-types',
      '--no-warnings',
      join(import.meta.dirname, '../src/mcp/http.ts'),
    ],
    {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        WHATMCP_HOME: dir,
        WHATMCP_HTTP_PORT: String(port),
        WHATMCP_HTTP_TOKEN: token,
        WHATMCP_NO_DASHBOARD: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP server did not start')), 5000);
      let output = '';
      child.stderr!.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('whatmcp http on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`HTTP server exited early (${code}): ${output}`));
      });
    });

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{malformed',
    });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{malformed',
    });
    assert.equal(authenticated.status, 400);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
