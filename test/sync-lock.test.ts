import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireSyncLock } from '../src/sync-lock.ts';

test('sync lock rejects a competing process immediately and recovers on release', t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-sync-lock-'));
  const lockPath = join(dir, 'sync-lock.db');
  const release = tryAcquireSyncLock(lockPath);
  t.after(() => {
    release?.();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(release);

  const probe = () => spawnSync(process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    '--input-type=module', '-e',
    `import { tryAcquireSyncLock } from ${JSON.stringify(new URL('../src/sync-lock.ts', import.meta.url).href)};
     const release = tryAcquireSyncLock(process.argv[1]);
     if (!release) process.exit(75);
     release();`,
    lockPath,
  ], { encoding: 'utf8', timeout: 3000 });

  const busy = probe();
  assert.equal(busy.status, 75, busy.stderr);
  release();
  const free = probe();
  assert.equal(free.status, 0, free.stderr);
});

test('killing a blocked worker releases its sync lock', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-killed-lock-'));
  const lockPath = join(dir, 'sync-lock.db');
  const child = spawn(process.execPath, [
    '--experimental-sqlite', '--experimental-strip-types', '--no-warnings',
    '--expose-gc',
    '--input-type=module', '-e',
    `import { tryAcquireSyncLock } from ${JSON.stringify(new URL('../src/sync-lock.ts', import.meta.url).href)};
     const release = tryAcquireSyncLock(process.argv[1]);
     if (!release) process.exit(75);
     // Retain the owner in a live callback: an empty interval does not keep the
     // DatabaseSync/release closure reachable after this eval module finishes.
     process.on('message', command => {
       if (command === 'collect') {
         global.gc();
         global.gc();
         process.send('collected');
       } else if (command === 'release') release();
     });
     process.send('locked');`,
    lockPath,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let release: ReturnType<typeof tryAcquireSyncLock> = null;
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    release?.();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  const [ready] = await once(child, 'message', { signal: t.signal });
  assert.equal(ready, 'locked', stderr);
  release = tryAcquireSyncLock(lockPath);
  assert.equal(release, null);

  // Make the former intermittent lifetime bug deterministic, including on Mac.
  const collected = once(child, 'message', { signal: t.signal });
  child.send('collect');
  assert.equal((await collected)[0], 'collected', stderr);
  release = tryAcquireSyncLock(lockPath);
  assert.equal(release, null);

  child.kill('SIGKILL');
  await closed;
  release = tryAcquireSyncLock(lockPath);
  assert.ok(release);
  release();
});
