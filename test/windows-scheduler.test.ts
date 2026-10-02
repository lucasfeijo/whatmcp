import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderWindowsSyncLauncher, renderWindowsSyncTask, syncIntervalMinutes,
} from '../src/windows-scheduler.ts';

test('Windows interval supports hourly and daily cadences but rejects invalid values', () => {
  assert.equal(syncIntervalMinutes(6), 360);
  assert.equal(syncIntervalMinutes(24), 1440);
  assert.throws(() => syncIntervalMinutes(0), /between 1 minute/);
  assert.throws(() => syncIntervalMinutes(Infinity), /between 1 minute/);
});

test('scheduled launcher carries configured paths without a backup password or API key', () => {
  const launcher = renderWindowsSyncLauncher(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\O'Brien\\whatmcp\\src\\cli.ts",
    'C:\\whatmcp\\logs\\sync.log',
    'C:\\whatmcp',
    'C:\\WhatsApp\\ChatStorage.sqlite',
  );
  assert.match(launcher, /WHATMCP_HOME = 'C:\\whatmcp'/);
  assert.match(launcher, /WHATMCP_CHATSTORAGE = 'C:\\WhatsApp\\ChatStorage.sqlite'/);
  assert.match(launcher, /O''Brien/);
  assert.doesNotMatch(launcher, /ALLOW_STOP_WHATSAPP/);
  assert.match(launcher, /'--scheduled'/);
  assert.doesNotMatch(launcher, /BACKUP_PASSWORD|OPENAI_API_KEY/);
});

test('task XML encodes paths and prevents overlapping sync jobs', () => {
  const task = renderWindowsSyncTask('C:\\R&D\\sync-windows.ps1', 360,
    new Date('2026-09-22T12:00:00Z'));
  assert.match(task, /<Interval>PT360M<\/Interval>/);
  assert.match(task, /R&amp;D/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(task, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
});
