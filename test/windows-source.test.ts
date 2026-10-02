import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHotCopy, withWindowsSyncLock } from '../src/index/windows-source.ts';
import type { Config } from '../src/config.ts';

test('a pending sync prevents a second acquisition and releases its lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    assert.equal(await withWindowsSyncLock(lock, async () => {
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
      await assert.rejects(withWindowsSyncLock(lock, () => 'second'),
        /already running/);
      return 'first';
    }), 'first');
    assert.equal(await withWindowsSyncLock(lock, () => 'later'), 'later');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead process lock is recovered without suppressing the next sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-lock-'));
  const lock = join(dir, 'windows-sync.lock');
  try {
    writeFileSync(lock, '99999999');
    assert.equal(await withWindowsSyncLock(lock, () => 'recovered'), 'recovered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const result = { scanned: 2, added: 1, recovered: 0, skipped: 0, windowsBuilt: 1, windowsDropped: 0, total: 3 };

async function fakeHotCopy(body: string, check: (script: string, cfg: Config, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'whatmcp-hotcopy-'));
  const script = join(dir, 'hotcopy.ps1');
  try {
    writeFileSync(script, [
      'param([string]$DataDirectory,[string]$Waren6Directory,[string]$NodePath,[string]$StorePath,[string]$CasesDirectory,[switch]$Full,[switch]$ResultJson)',
      body,
    ].join('\r\n'));
    await check(script, { windowsWaren6Path: dir, windowsOutputDir: dir, store: join(dir, 'custom archive.db') } as Config, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('hot copy passes configured paths and full mode, streams progress and parses a split result', { skip: process.platform !== 'win32' }, async () => {
  await fakeHotCopy([
    "if (-not $Full -or -not $ResultJson) { throw 'Missing switches' }",
    "if (-not $DataDirectory -or $NodePath -ne '" + process.execPath.replaceAll("'", "''") + "') { throw 'Missing runtime paths' }",
    "if ($StorePath -ne (Join-Path $Waren6Directory 'custom archive.db') -or $CasesDirectory -ne $Waren6Directory) { throw 'Wrong config paths' }",
    "Write-Output 'WhatsApp remains open'",
    "[Console]::Write('WHATMCP_HOTCOPY_RES')",
    'Start-Sleep -Milliseconds 50',
    "[Console]::WriteLine('ULT=" + JSON.stringify(result) + "')",
  ].join('\r\n'), async (script, cfg) => {
    const progress: string[] = [];
    assert.deepEqual(await runHotCopy(script, cfg, { full: true, progress: message => progress.push(message) }), result);
    assert.deepEqual(progress, ['WhatsApp remains open']);
  });
});

test('hot copy rejects failures even if the process emitted a success result', { skip: process.platform !== 'win32' }, async () => {
  await fakeHotCopy("Write-Output 'WHATMCP_HOTCOPY_RESULT=" + JSON.stringify(result) + "'\r\nexit 7", async (script, cfg) => {
    await assert.rejects(runHotCopy(script, cfg), /exited with 7/);
  });
});

test('hot copy rejects missing or malformed import results', { skip: process.platform !== 'win32' }, async () => {
  for (const output of ['no result', 'WHATMCP_HOTCOPY_RESULT={"added":1}']) {
    await fakeHotCopy("Write-Output '" + output + "'", async (script, cfg) => {
      await assert.rejects(runHotCopy(script, cfg), /did not return|Invalid hot-copy/);
    });
  }
});
