/**
 * Interactive first-run setup.
 *
 * The goal is that someone who just cloned this repo gets from zero to a working,
 * connected, self-updating archive without reading the README first — and, where
 * something needs a decision (money, background processes, sleep settings), that
 * they are told what it costs before they agree rather than after.
 *
 * Ordering is deliberate: every step that can fail cheaply runs before any step
 * that spends money or installs anything. Full Disk Access is checked first,
 * because it is the one failure that stops everything and the one nobody
 * diagnoses correctly on their own.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  loadConfig, writeFileConfig, ensureDataDir, maskKey,
  CONFIG_PATH, DATA_DIR,
} from './config.ts';
import { runPreflight } from './preflight.ts';
import { runIndex } from './index/indexer.ts';
import { embedMissing, vectorCoverage, estimatePending } from './index/embed.ts';
import { openStore } from './db/index.ts';
import { embed as apiEmbed } from './index/openai.ts';
import { calibrateThresholds } from './search/calibrate.ts';
import { createSecretOutput } from './secret-input.ts';
import { installWindowsSyncTask, disableWindowsSyncTask } from './windows-scheduler.ts';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const REPO = join(import.meta.dirname, '..');

function rule(title: string): void {
  console.log(`\n${bold(title)}\n${dim('─'.repeat(Math.max(24, title.length)))}`);
}

export async function runSetup(): Promise<void> {
  /*
   * This wizard asks questions, so it needs a real terminal.
   *
   * Without this guard the failure is genuinely baffling: with piped stdin,
   * readline drains every line the moment the stream opens and then closes the
   * interface, so the FIRST question consumes a line and every later one waits
   * forever on an interface that will never emit again. Node exits with code 13
   * ("unsettled top-level await") and prints nothing at all. Refusing up front,
   * with the non-interactive path spelled out, costs four lines.
   */
  if (!stdin.isTTY) {
    console.error(
      'npm run setup needs an interactive terminal.\n\n' +
      'Non-interactive equivalent:\n' +
      '  npm run wa -- set-key < /path/to/protected-key-file\n' +
      '  npm run sync\n' +
      '  npm run wa -- calibrate\n' +
      '  npm run wa -- sync-every 6      # background sync, 0 to disable',
    );
    process.exitCode = 1;
    return;
  }

  const secretOutput = createSecretOutput(stdout);
  const rl = createInterface({ input: stdin, output: secretOutput.stream, terminal: true });
  /*
   * Resolve pending questions if the interface closes underneath us (Ctrl-D,
   * or a terminal that goes away), rather than hanging on a promise nobody will
   * ever settle.
   */
  let closed = false;
  rl.on('close', () => { closed = true; });
  const askRaw = async (q: string): Promise<string> => {
    if (closed) return '';
    return (await rl.question(q)).trim();
  };
  const ask = async (q: string, fallback = '') => (await askRaw(q)) || fallback;
  const askSecret = async (q: string) => closed ? '' : secretOutput.question(rl, q);
  const confirm = async (q: string, def = true) => {
    const a = (await askRaw(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (!a) return def;
    return a.startsWith('y');
  };

  try {
    console.log(bold('\nWhatMCP setup'));
    console.log(dim('Local, read-only archive of your WhatsApp history, searchable by AI.\n'));

    // --- 1. preflight ------------------------------------------------------
    rule('1. Checking this Mac');
    let cfg = loadConfig();
    const checks = runPreflight(cfg.chatstorage);
    let blocked = false;
    for (const c of checks) {
      console.log(`  ${c.ok ? green('✓') : red('✗')} ${c.label}: ${c.detail}`);
      if (!c.ok && c.fix) {
        console.log(`\n${c.fix.split('\n').map((l) => '    ' + l).join('\n')}\n`);
        blocked = true;
      }
    }
    if (blocked) {
      console.log(red('\nFix the above, then run `npm run setup` again.'));
      return;
    }

    // --- 2. API key --------------------------------------------------------
    rule('2. OpenAI API key');
    console.log(
      'Used ONLY to turn text into embedding vectors, so search can match by\n' +
      'meaning. Your messages, the archive and the search itself stay on this Mac.\n' +
      dim('Indexing sends each conversation window once; searching sends the query.\n'),
    );
    if (cfg.openaiKey) {
      console.log(`  already configured: ${maskKey(cfg.openaiKey)}`);
      if (await confirm('  Replace it?', false)) cfg = await promptKey(askSecret);
    } else {
      cfg = await promptKey(askSecret);
    }
    if (!cfg.openaiKey) {
      console.log(yellow('\nNo key set. You can still index and use keyword search:'));
      console.log('  npm run wa -- index');
      console.log('  npm run wa -- search "something" --mode=bm25');
      return;
    }

    // --- 3. build the archive ---------------------------------------------
    rule('3. Building the archive');
    console.log('Reading WhatsApp\'s local database (a snapshot — the original is never written to).');
    const t0 = Date.now();
    const r = runIndex(cfg.store, {
      chatstorage: cfg.chatstorage,
      onProgress: (m) => console.log(dim(`  ${m}`)),
    });
    console.log(
      `  ${green('✓')} ${r.totalMessages.toLocaleString()} messages, ` +
      `${r.windowsBuilt.toLocaleString()} conversation windows ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );

    // --- 4. embeddings -----------------------------------------------------
    rule('4. Embeddings');
    const ec = { model: cfg.openaiModel, dimensions: cfg.openaiDims, apiKey: cfg.openaiKey };
    const estimate = estimatePending(cfg.store, ec);
    if (estimate.pending > 0) {
      console.log(
        `  ${estimate.pending.toLocaleString()} windows to embed ` +
        `(~${estimate.tokens.toLocaleString()} tokens), about ` +
        `${bold('$' + estimate.costUSD.toFixed(2))} once.`,
      );
      if (!(await confirm('  Embed now?'))) {
        console.log(dim('  Skipped. Run `npm run wa -- embed` when ready.'));
      } else {
        await embedMissing(cfg.store, ec, {
          onProgress: (e) => {
            if (e.phase === 'progress') {
              stdout.write(`\r  ${e.done}/${e.pending}  ${e.rate}/s   `);
            } else if (e.phase === 'done') {
              stdout.write('\r');
              console.log(
                `  ${green('✓')} embedded ${e.embedded.toLocaleString()} in ` +
                `${(e.elapsedMs / 1000).toFixed(0)}s for $${e.costUSD.toFixed(4)}`,
              );
            }
          },
        });
        await calibrate(cfg);
      }
    } else {
      console.log(`  ${green('✓')} already complete`);
    }

    // --- 5. periodic sync --------------------------------------------------
    rule('5. Keeping it up to date');
    console.log(
      'WhatsApp prunes its own local database, so anything it drops before the\n' +
      'next sync is gone for good. A background sync every few hours is what makes\n' +
      'this an archive rather than a snapshot.\n' +
      dim('Routine syncs cost fractions of a cent; a quiet interval costs nothing.\n'),
    );
    const hoursRaw = await ask('  Sync every how many hours? (0 = manual only) [6] ', '6');
    const hours = Math.max(0, Number(hoursRaw) || 0);
    if (hours > 0) {
      writeFileConfig({ sync_interval_hours: hours });
      installSyncAgent(hours);
      console.log(`  ${green('✓')} syncing every ${hours}h in the background`);
      console.log(dim(`    logs: ~/.whatmcp/logs/sync.log`));
      console.log(dim(`    stop: launchctl bootout gui/$(id -u)/com.whatmcp.sync`));
    } else {
      writeFileConfig({ sync_interval_hours: 0 });
      console.log(dim('  Manual only — run `npm run sync` when you want it.'));
    }

    // --- 6. sleep ----------------------------------------------------------
    rule('6. Sleep');
    const sleepMin = currentSleepMinutes();
    console.log(
      'A sleeping Mac does not sync, and does not serve remote requests.\n' +
      (sleepMin !== null
        ? `  This Mac currently sleeps after ${bold(String(sleepMin) + ' min')} of inactivity.\n`
        : ''),
    );
    console.log(
      '  Scheduled syncs still run: launchd wakes for them if the Mac is plugged in,\n' +
      '  and otherwise catches up on wake — nothing is lost either way.\n\n' +
      '  It only matters if you expose the MCP server remotely, where a sleeping Mac\n' +
      '  means an endpoint that vanishes. To prevent sleep on AC power:\n' +
      dim('    sudo pmset -c sleep 0        (needs your password; -c = plugged in only)\n') +
      dim('    sudo pmset -c sleep 10       to undo it later\n'),
    );

    // --- 7. connect --------------------------------------------------------
    rule('7. Connect an AI client');
    const serverPath = join(REPO, 'src/mcp/server.ts');
    console.log('Claude Code:\n');
    console.log(dim(
      `  claude mcp add whatmcp -- node --experimental-sqlite ` +
      `--experimental-strip-types --no-warnings ${serverPath}\n`,
    ));
    console.log('Claude Desktop — add to');
    console.log(dim('  ~/Library/Application Support/Claude/claude_desktop_config.json\n'));
    console.log(dim(JSON.stringify({
      mcpServers: {
        whatmcp: {
          command: process.execPath,
          args: [
            '--experimental-sqlite',
            '--experimental-strip-types',
            '--no-warnings',
            serverPath,
          ],
        },
      },
    }, null, 2).split('\n').map((l) => '  ' + l).join('\n')));
    console.log(
      `\n${dim('No API key goes in that file — a GUI-launched server inherits none of your')}\n` +
      `${dim('shell environment, which is why the key lives in ~/.whatmcp/config.json.')}`,
    );
    console.log(
      `\n${yellow('If you use Claude Desktop')}, grant it Full Disk Access too ` +
      `(System Settings ->\nPrivacy & Security), or syncing from inside it will fail ` +
      `the same way\nthis script would have.`,
    );

    // --- done --------------------------------------------------------------
    rule('Done');
    const db = openStore(cfg.store);
    const cov = vectorCoverage(db, ec);
    db.close();
    console.log(
      `  archive:  ${cfg.store}\n` +
      `  windows:  ${cov.embedded.toLocaleString()}/${cov.windows.toLocaleString()} embedded (${cov.pct}%)\n` +
      `  config:   ${CONFIG_PATH}\n\n` +
      `  try it:   npm run wa -- search "something you talked about"\n` +
      `  status:   npm run doctor\n` +
      `  remote:   see docs/REMOTE.md to reach this from outside the Mac\n`,
    );
  } finally {
    rl.close();
  }
}

async function promptKey(askSecret: (q: string) => Promise<string>) {
  console.log(dim('  Get one at https://platform.openai.com/api-keys'));
  const key = await askSecret('  Paste your OpenAI API key (input hidden): ');
  if (!key) return loadConfig();
  if (!/^sk-[^\s]+$/.test(key)) {
    console.log(red('  That does not look like an OpenAI key (expected it to start with "sk-").'));
    return loadConfig();
  }
  process.stdout.write('  verifying… ');
  try {
    await apiEmbed({ model: 'text-embedding-3-small', dimensions: 1536, apiKey: key }, ['ping']);
    console.log(green('ok'));
  } catch (e) {
    console.log(red(`failed: ${(e as Error).message}`));
    return loadConfig();
  }
  ensureDataDir();
  writeFileConfig({ openai_api_key: key });
  console.log(dim(`  stored 0600 in ${CONFIG_PATH}`));
  return loadConfig();
}

/**
 * Fit the similarity thresholds to this corpus.
 *
 * Runs right after the first embed because the defaults in code are a guess and
 * the difference is not subtle — on the reference corpus the measured value was
 * 0.306 against a hard-coded 0.42, which would have marked almost nothing as a
 * confident match. `embed` and `sync` do the same for anyone who defers the
 * embed rather than running it here.
 */
async function calibrate(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  process.stdout.write('  calibrating relevance thresholds… ');
  try {
    const r = await calibrateThresholds(cfg);
    console.log(r ? green(`strong=${r.strong} min=${r.minSim}`) : dim('skipped (no vectors)'));
  } catch (e) {
    // A tuning pass is not worth failing setup over; the archive is already built.
    console.log(yellow(`skipped (${(e as Error).message})`));
    console.log(dim('  run `npm run wa -- calibrate` later'));
  }
}

/** Render and load the periodic-sync LaunchAgent. */
export function installSyncAgent(hours: number): void {
  if (process.platform === 'win32') {
    installWindowsSyncTask(hours, REPO);
    return;
  }
  const agents = join(homedir(), 'Library/LaunchAgents');
  const logs = join(DATA_DIR, 'logs');
  if (!existsSync(agents)) mkdirSync(agents, { recursive: true });
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });

  const tpl = readFileSync(join(REPO, 'deploy/com.whatmcp.sync.plist'), 'utf8')
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__REPO__', REPO)
    .replaceAll('__HOME__', homedir())
    .replaceAll('__INTERVAL__', String(Math.round(hours * 3600)));

  const dest = join(agents, 'com.whatmcp.sync.plist');
  writeFileSync(dest, tpl);

  const uid = String(process.getuid?.() ?? 501);
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/com.whatmcp.sync`], { stdio: 'ignore' });
  } catch { /* not loaded yet */ }
  // launchd returns "Input/output error" if bootstrap races a still-unloading
  // job, so give the previous one a moment to actually go away.
  execFileSync('sleep', ['1']);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, dest]);
}

/** Remove only the WhatMCP periodic task/agent, not its archive or logs. */
export function disableSyncAgent(): void {
  if (process.platform === 'win32') {
    disableWindowsSyncTask();
    return;
  }
  const uid = String(process.getuid?.() ?? 501);
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/com.whatmcp.sync`], { stdio: 'ignore' });
  } catch { /* not loaded */ }
}

/** Current idle-sleep setting in minutes, or null if it cannot be read. */
function currentSleepMinutes(): number | null {
  try {
    const out = execFileSync('pmset', ['-g', 'custom'], { encoding: 'utf8' });
    const m = /^\s*sleep\s+(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
