/** Per-user Windows Task Scheduler registration for periodic archive sync. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';

const TASK_NAME = 'WhatMCP Sync';
const NODE_FLAGS = ['--experimental-sqlite', '--experimental-strip-types', '--no-warnings'];

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Task Scheduler repetition is in whole minutes, from 1 minute to 31 days. */
export function syncIntervalMinutes(hours: number): number {
  const minutes = Math.round(hours * 60);
  if (!Number.isFinite(hours) || minutes < 1 || minutes > 31 * 24 * 60) {
    throw new Error('Windows sync interval must be between 1 minute and 31 days');
  }
  return minutes;
}

export function renderWindowsSyncLauncher(
  nodePath: string, cliPath: string, logPath: string,
  home: string, source?: string,
): string {
  return [
    `$env:WHATMCP_HOME = ${ps(home)}`,
    ...(source ? [`$env:WHATMCP_CHATSTORAGE = ${ps(source)}`] : []),
    `$log = ${ps(logPath)}`,
    `& ${ps(nodePath)} ${NODE_FLAGS.map(ps).join(' ')} ${ps(cliPath)} 'sync' '--scheduled' *>> $log`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

export function renderWindowsSyncTask(launcher: string, minutes: number, start: Date): string {
  const local = new Date(start.getTime() - start.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><TimeTrigger><Repetition><Interval>PT${minutes}M</Interval></Repetition><StartBoundary>${local}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;${xml(launcher)}&quot;</Arguments></Exec></Actions>
</Task>
`;
}

export function installWindowsSyncTask(hours: number, repo: string): void {
  const minutes = syncIntervalMinutes(hours);
  const logs = join(DATA_DIR, 'logs');
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
  const launcher = join(DATA_DIR, 'sync-windows.ps1');
  const task = join(DATA_DIR, 'sync-windows.xml');
  writeFileSync(launcher, '\uFEFF' + renderWindowsSyncLauncher(
    process.execPath, join(repo, 'src/cli.ts'), join(logs, 'sync.log'),
    DATA_DIR, process.env.WHATMCP_CHATSTORAGE,
  ));
  writeFileSync(task, renderWindowsSyncTask(launcher, minutes, new Date(Date.now() + 60_000)));
  execFileSync('schtasks.exe', ['/Create', '/TN', TASK_NAME, '/XML', task, '/F'], { stdio: 'pipe' });
}

export function disableWindowsSyncTask(): void {
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], { stdio: 'pipe' });
  } catch {
    return; // no registered task
  }
  execFileSync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { stdio: 'pipe' });
}
