import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

for (const fail of [false, true]) {
  test(`new CLI workers share ${fail ? 'failure' : 'success'} when started by independent parents`, { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-worker-shared-'));
    const pending: Promise<unknown>[] = [];
    try {
      const source = join(dir, 'ChatStorage.sqlite');
      const db = new DatabaseSync(source);
      db.exec(`CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY,ZCONTACTJID TEXT,ZPARTNERNAME TEXT);
        CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY,ZMEMBERJID TEXT,ZCONTACTNAME TEXT);
        CREATE TABLE ZWAPROFILEPUSHNAME (ZJID TEXT,ZPUSHNAME TEXT);
        CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY,ZSTANZAID TEXT,ZISFROMME INTEGER,
          ZMESSAGETYPE INTEGER,ZTEXT TEXT,ZMESSAGEDATE REAL,ZCHATSESSION INTEGER,
          ZGROUPMEMBER INTEGER,ZPARENTMESSAGE INTEGER);
        INSERT INTO ZWACHATSESSION VALUES(1,'123@s.whatsapp.net','Fixture');
        INSERT INTO ZWAMESSAGE VALUES(1,'fresh',0,0,'fixture',700000000,1,NULL,NULL);`);
      db.close();
      const copies = join(dir, 'copies');
      const preload = join(dir, 'delay-copy.mjs');
      // Test-only source delay; no production sleeps or network/model calls.
      writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        const original = fs.copyFileSync;
        fs.copyFileSync = (src, ...args) => {
          if (String(src) === ${JSON.stringify(source)}) {
            fs.appendFileSync(${JSON.stringify(copies)}, 'copy\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
            ${fail ? "throw new Error('fixture source failure');" : ''}
          }
          return original(src, ...args);
        }; syncBuiltinESMExports();`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('WHATMCP_') || key === 'OPENAI_API_KEY' || key === 'NODE_OPTIONS') delete env[key];
      }
      Object.assign(env, { WHATMCP_HOME: dir, WHATMCP_SOURCE_TYPE: 'chatstorage',
        WHATMCP_STORE: join(dir, 'archive.db'), WHATMCP_CHATSTORAGE: source,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
      const start = (args: string[], extraEnv: Record<string, string> = {}) => {
        const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--experimental-sqlite', '--experimental-strip-types',
            '--no-warnings', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args],
          { env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { output += chunk; });
          child.once('error', reject);
          child.once('close', code => resolve({ code, output }));
        });
        pending.push(result);
        return result;
      };
      const owner = start(['sync-worker']);
      const deadline = Date.now() + 5000;
      while (!existsSync(copies) && Date.now() < deadline) await pause(25);
      assert.equal(existsSync(copies), true, 'owner reached source acquisition');
      const follower = start(['sync-worker']);
      const otherStore = join(dir, 'other-store.db');
      const isolated = start(['sync-worker'], { WHATMCP_STORE: otherStore });
      const results = await Promise.all([owner, follower]);
      assert.equal((await isolated).code, 75, 'another store must not share this result');
      assert.equal(existsSync(otherStore), false);
      for (const result of results) assert.equal(result.code, fail ? 1 : 0, result.output);
      assert.match(results[1].output, new RegExp(`shared sync finished with exit ${fail ? 1 : 0}`));
      assert.equal(readFileSync(copies, 'utf8'), 'copy\n');
      if (!fail) {
        // The new parent and child hold different coordinator locks.
        const nested = await start(['sync', '--full']);
        assert.equal(nested.code, 0, nested.output);
        assert.match(nested.output, /done in/);
        assert.equal(readFileSync(copies, 'utf8'), 'copy\ncopy\n');
      }
    } finally {
      await Promise.allSettled(pending);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
