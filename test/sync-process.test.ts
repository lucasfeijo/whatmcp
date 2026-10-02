import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSyncProcess, syncTimeoutMs, syncWorkerCommand } from '../src/sync-process.ts';

test('timed-out sync is reaped and scheduled attempts pause until manual success', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-sync-pause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pausePath = join(dir, 'paused.json');
  const started = Date.now();
  const code = await runSyncProcess(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { timeoutMs: 200, graceMs: 100, pausePath },
  );
  assert.equal(code, 124);
  assert.ok(Date.now() - started < 5000);
  assert.equal(existsSync(pausePath), true);

  assert.equal(await runSyncProcess(process.execPath, ['-e', 'process.exit(37)'],
    { scheduled: true, pausePath }), 76);
  assert.equal(await runSyncProcess(process.execPath, ['-e', ''],
    { pausePath }), 0);
  assert.equal(existsSync(pausePath), false);
});

test('sync watchdog preserves successful exit', async () => {
  let output = '';
  assert.equal(await runSyncProcess(process.execPath,
    ['-e', 'process.stdout.write("ready\\n")'], {
      timeoutMs: 1000, graceMs: 100,
      pausePath: join(tmpdir(), `whatmcp-unused-pause-${process.pid}.json`),
      onOutput: chunk => { output += chunk; },
    }), 0);
  assert.equal(output, 'ready\n');
});

 test('Windows timeout and sync worker preserve platform policy', () => {
   assert.equal(syncTimeoutMs('windows-waren6'), 30 * 60000);
   assert.equal(syncTimeoutMs('chatstorage'), 5 * 60000);
   assert.ok(!syncWorkerCommand(false)[1].includes('--index-only'));
 });

test('Windows watchdog terminates descendants of its worker', { skip: process.platform !== 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-tree-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let output = '';
  const code = await runSyncProcess(process.execPath, ['-e',
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); console.log(child.pid); setInterval(()=>{},1000);'], {
    timeoutMs: 2500, pausePath: join(dir, 'paused.json'), onOutput: chunk => { output += chunk; },
  });
  assert.equal(code, 124);
  const pid = Number(output.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
