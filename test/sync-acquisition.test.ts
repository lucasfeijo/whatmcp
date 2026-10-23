import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACQUISITION_REUSE_MS, canReuseAcquisition, completeAcquisitionRun, invalidateAcquisition, recordAcquisition } from '../src/sync-acquisition.ts';

test('only fresh successful matching acquisitions can be reused; full always acquires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-acquisition-'));
  try {
    const path = join(dir, 'state'), store = join(dir, 'store.db');
    const cfg = { sourceType: 'windows-waren6' as const, store, chatstorage: '',
      windowsWaren6Path: 'WAren6', windowsSourcePath: 'source', windowsOutputDir: 'cases',
      mediaSourceId: 'windows', mediaRoots: {} };
    writeFileSync(store, 'fixture');
    assert.equal(canReuseAcquisition(cfg, false, path, 1000), false);
    recordAcquisition(cfg, path, 1000);
    assert.equal(canReuseAcquisition(cfg, false, path, 1001), true);
    assert.equal(canReuseAcquisition(cfg, true, path, 1001), false);
    assert.equal(canReuseAcquisition(cfg, false, path, 1000 + ACQUISITION_REUSE_MS), false);
    assert.equal(canReuseAcquisition(cfg, false, path, 999), false);
    assert.equal(canReuseAcquisition({ ...cfg, windowsSourcePath: 'other' }, false, path, 1001), false);
    // Slow processing may finish after the acquisition window has elapsed.
    completeAcquisitionRun(cfg, path, 200_000);
    assert.equal(canReuseAcquisition(cfg, false, path, 200_001), true);
    // Another completion cannot make the original source snapshot fresh forever.
    completeAcquisitionRun(cfg, path, 300_000);
    assert.equal(canReuseAcquisition(cfg, false, path, 300_001), false);
    invalidateAcquisition(path);
    assert.equal(canReuseAcquisition(cfg, false, path, 1001), false);
    recordAcquisition(cfg, path, 1000);
    rmSync(store);
    assert.equal(canReuseAcquisition(cfg, false, path, 1001), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI reuses acquisition but still processes pending work; full bypasses reuse', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-acquisition-cli-'));
  try {
    const store = join(dir, 'store.db');
    writeFileSync(store, 'fixture');
    const env = { ...process.env, WHATMCP_HOME: dir, WHATMCP_STORE: store,
      WHATMCP_SOURCE_TYPE: 'chatstorage', WHATMCP_CHATSTORAGE: join(dir, 'missing-source'), OPENAI_API_KEY: '' };
    const flags = ['--experimental-sqlite', '--experimental-strip-types', '--no-warnings'];
    const configUrl = new URL('../src/config.ts', import.meta.url).href;
    const reuseUrl = new URL('../src/sync-acquisition.ts', import.meta.url).href;
    execFileSync(process.execPath, [...flags, '--input-type=module', '-e',
      `import {loadConfig} from ${JSON.stringify(configUrl)};
       import {recordAcquisition} from ${JSON.stringify(reuseUrl)};
       recordAcquisition(loadConfig());`], { env });
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const output = execFileSync(process.execPath, [...flags, cli, 'sync-worker'], { env, encoding: 'utf8' });
    assert.match(output, /reusing successful acquisition/);
    assert.match(output, /embedding skipped: no OpenAI key/);
    const full = spawnSync(process.execPath, [...flags, cli, 'sync-worker', '--full'], { env, encoding: 'utf8' });
    assert.notEqual(full.status, 0);
    assert.doesNotMatch(full.stdout, /reusing successful acquisition/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('macOS and Linux always acquire even when a recent reuse marker exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-acquisition-nonwindows-'));
  try {
    const store = join(dir, 'store.db');
    writeFileSync(store, 'fixture');
    const env = { ...process.env, WHATMCP_HOME: dir, WHATMCP_STORE: store,
      WHATMCP_SOURCE_TYPE: 'chatstorage', WHATMCP_CHATSTORAGE: join(dir, 'missing-source'), OPENAI_API_KEY: '' };
    const flags = ['--experimental-sqlite', '--experimental-strip-types', '--no-warnings'];
    const configUrl = new URL('../src/config.ts', import.meta.url).href;
    const reuseUrl = new URL('../src/sync-acquisition.ts', import.meta.url).href;
    execFileSync(process.execPath, [...flags, '--input-type=module', '-e',
      `import {loadConfig} from ${JSON.stringify(configUrl)};
       import {recordAcquisition} from ${JSON.stringify(reuseUrl)};
       recordAcquisition(loadConfig());`], { env });
    for (const platform of ['darwin', 'linux']) {
      const preload = 'data:text/javascript,' + encodeURIComponent(
        `Object.defineProperty(process, 'platform', {value: '${platform}'});`);
      const result = spawnSync(process.execPath, [...flags, '--import', preload,
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'sync-worker'], { env, encoding: 'utf8' });
      assert.notEqual(result.status, 0, 'must attempt the missing source instead of reusing acquisition');
      assert.doesNotMatch(result.stdout, /reusing successful acquisition/);
      assert.equal(existsSync(join(dir, 'sync-worker-coordinator.json')), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
