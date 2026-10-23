import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinateSync, syncCovers } from '../src/sync-coordinator.ts';
import { tryAcquireSyncLock } from '../src/sync-lock.ts';
import { runSyncProcess } from '../src/sync-process.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const worker = ['cli.ts', 'sync-worker'];

test('different source/store identities cannot share a successful result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-identity-'));
  try {
    const options = { coordinationPath: join(dir, 'state'), onOutput: () => {} };
    let starts = 0;
    const action = async () => { starts++; await pause(150); return 0; };
    const owner = coordinateSync('node', worker, { ...options, coordinationIdentity: 'store-a' }, action);
    const other = coordinateSync('node', worker, { ...options, coordinationIdentity: 'store-b' }, action);
    assert.deepEqual(await Promise.all([owner, other]), [0, 75]);
    assert.equal(starts, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent requests share one worker, including its failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coordinate-'));
  try {
    for (const code of [0, 37, 124]) {
      const options = { coordinationPath: join(dir, `state-${code}`), onOutput: () => {}, timeoutMs: 2000 };
      let starts = 0;
      const action = async () => { starts++; await pause(150); return code; };
      const first = coordinateSync('node', worker, options, action);
      const others = [coordinateSync('node', worker, options, action), coordinateSync('node', worker, options, action)];
      assert.deepEqual(await Promise.all([first, ...others]), [code, code, code]);
      assert.equal(starts, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('full and postprocessing requests cannot reuse a weaker running worker or enqueue work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coordinate-'));
  try {
    for (const [active, requested] of [[worker, [...worker, '--full']],
      [[...worker, '--index-only'], worker], [[...worker, '--skip-auto-transcription'], worker]]) {
      const options = { coordinationPath: join(dir, Math.random().toString()), onOutput: () => {} };
      let starts = 0;
      const action = async () => { starts++; await pause(150); return 0; };
      const owner = coordinateSync('node', active, options, action);
      const follower = coordinateSync('node', requested, options, action);
      assert.deepEqual(await Promise.all([owner, follower]), [0, 75]);
      assert.equal(starts, 1);
    }
    assert.equal(syncCovers({ command: 'node', args: [...worker, '--full'] }, 'node', worker), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('abandoned owner cannot turn an old successful state into success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coordinate-'));
  const path = join(dir, 'state');
  try {
    writeFileSync(path, JSON.stringify({ id: 'old', command: 'node', args: worker,
      started: 1, finished: 2, code: 0 }));
    const release = tryAcquireSyncLock(`${path}.lock.db`)!;
    let starts = 0;
    const follower = coordinateSync('node', worker, { coordinationPath: path, onOutput: () => {} }, async () => { starts++; return 0; });
    await pause(20);
    release();
    assert.equal(await follower, 75);
    assert.equal(starts, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('follower timeout does not cancel the owner or run another extraction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coordinate-'));
  try {
    const options = { coordinationPath: join(dir, 'state'), onOutput: () => {} };
    const owner = coordinateSync('node', worker, options, async () => { await pause(200); return 0; });
    assert.equal(await coordinateSync('node', worker, { ...options, timeoutMs: 20 }, async () => 99), 124);
    assert.equal(await owner, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('supervised processes share the actual child exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-coordinate-'));
  try {
    const options = { coordinationPath: join(dir, 'state'), pausePath: join(dir, 'pause'),
      onOutput: () => {}, timeoutMs: 5000 };
    const args = ['-e', 'setTimeout(() => process.exit(23), 250)'];
    const owner = runSyncProcess(process.execPath, args, options);
    const follower = runSyncProcess(process.execPath, args, options);
    assert.deepEqual(await Promise.all([owner, follower]), [23, 23]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent supervisors launch only one extraction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-independent-'));
  try {
    const runs = join(dir, 'runs');
    const workerScript = `require('node:fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');setTimeout(() => process.exit(0), 700)`;
    const runner = join(dir, 'runner.mjs');
    writeFileSync(runner, `import { runSyncProcess } from ${JSON.stringify(new URL('../src/sync-process.ts', import.meta.url).href)};
      process.exitCode = await runSyncProcess(process.execPath, ['-e', ${JSON.stringify(workerScript)}],
      ${JSON.stringify({ coordinationPath: join(dir, 'state'), pausePath: join(dir, 'pause'), timeoutMs: 5000 })});`);
    const start = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-sqlite', '--experimental-strip-types', '--no-warnings', runner], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', resolve);
    });
    const owner = start();
    await pause(100);
    const follower = start();
    assert.deepEqual(await Promise.all([owner, follower]), [0, 0]);
    assert.equal(readFileSync(runs, 'utf8'), 'run\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
