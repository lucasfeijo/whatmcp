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
import { existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  loadConfig, readFileConfig, writeFileConfig, ensureDataDir, maskKey,
  CONFIG_PATH, DATA_DIR,
} from './config.ts';
import { runPreflight } from './preflight.ts';
import { runIndex } from './index/indexer.ts';
import { embedMissing, vectorCoverage, estimatePending } from './index/embed.ts';
import { openStore } from './db/index.ts';
import { embed as apiEmbed } from './index/openai.ts';
import { calibrateThresholds } from './search/calibrate.ts';
import { createSecretOutput } from './secret-input.ts';
import { availableModels, installAppleModel } from './transcription/models.ts';
import { inventoryAudio, runTranscription } from './transcription/worker.ts';

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
    rule('1. Checking the source');
    let cfg = loadConfig();
    if (process.platform === 'win32') {
      const source = await ask(`  Compatible ChatStorage.sqlite path [${cfg.chatstorage}]: `,
        cfg.chatstorage);
      writeFileConfig({ chatstorage: source, media_source_id: 'import' });
      cfg = loadConfig();
    }
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
      'Used to embed conversation text; if you explicitly choose gpt-transcribe,\n' +
      'audio files are also sent to OpenAI. The archive stays on this computer.\n' +
      dim('Embedding sends each window once; semantic search sends its query.\n'),
    );
    if (cfg.openaiKey) {
      console.log(`  already configured: ${maskKey(cfg.openaiKey)}`);
      if (await confirm('  Replace it?', false)) cfg = await promptKey(askSecret);
    } else {
      cfg = await promptKey(askSecret);
    }
    if (!cfg.openaiKey) console.log(yellow('  Keyword search and local Apple transcription remain available.'));

    rule('3. Audio transcription');
    const savedModel = readFileConfig().transcription_model;
    let enable = false;
    if (savedModel) {
      console.log(`  currently enabled: ${savedModel}`);
      enable = !(await confirm('  Turn transcription off?', false));
      if (!enable) writeFileConfig({ transcription_model: null });
    } else {
      enable = await confirm('  Transcrever mensagens de áudio?', false);
      if (!enable) writeFileConfig({ transcription_model: null });
    }
    if (enable && !savedModel) {
      const available = (await availableModels(cfg)).filter((m) =>
        m.available || m.reason === 'locale asset not installed');
      if (!available.length) {
        console.log(yellow('  No transcription model is available on this computer.'));
        enable = false;
        writeFileConfig({ transcription_model: null });
      } else {
        available.forEach((m, i) => console.log(`  ${i + 1}. ${m.model}` +
          (m.available ? '' : ' (language asset download required)')));
        const answer = Number(await ask('  Choose a model [1]: ', '1'));
        if (!Number.isInteger(answer) || answer < 1 || answer > available.length) {
          throw new Error('Invalid transcription model selection');
        }
        const model = available[answer - 1].model;
        if (!available[answer - 1].available) {
          if (!(await confirm('  Install the Apple language asset now?', false))) {
            throw new Error('Language asset is required before selecting this model');
          }
          await installAppleModel(model, cfg.transcriptionLocale ?? 'pt-BR');
        }
        if (model === 'gpt-transcribe') {
          console.log('  Audio will be uploaded to OpenAI. The resulting text will also be sent');
          console.log('  to OpenAI if you later create text embeddings.');
        }
        writeFileConfig({ transcription_model: model });
      }
    }
    cfg = loadConfig();
    if (enable && process.platform === 'win32') {
      const root = await ask('  Extracted audio directory (leave blank to add later): ');
      if (root) {
        if (!existsSync(root) || !statSync(root).isDirectory()) {
          throw new Error('Extracted audio directory must exist');
        }
        writeFileConfig({ media_roots: { ...cfg.mediaRoots, import: root } });
      }
      cfg = loadConfig();
    }

    // --- 4. build the archive ---------------------------------------------
    rule('4. Building the archive');
    console.log('Reading WhatsApp\'s local database (a snapshot — the original is never written to).');
    const t0 = Date.now();
    const r = runIndex(cfg.store, {
      chatstorage: cfg.chatstorage,
      mediaSourceId: cfg.mediaSourceId,
      onProgress: (m) => console.log(dim(`  ${m}`)),
    });
    console.log(
      `  ${green('✓')} ${r.totalMessages.toLocaleString()} messages, ` +
      `${r.windowsBuilt.toLocaleString()} conversation windows ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );

    // --- 5. embeddings -----------------------------------------------------
    rule('5. Embeddings');
    const ec = { model: cfg.openaiModel, dimensions: cfg.openaiDims,
      apiKey: cfg.openaiKey ?? '' };
    const estimate = cfg.openaiKey ? estimatePending(cfg.store, ec) : null;
    if (!cfg.openaiKey) {
      console.log(dim('  Skipped: no API key. Keyword search is ready.'));
    } else if (estimate && estimate.pending > 0) {
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

    // --- 6. audio backfill -------------------------------------------------
    if (enable && cfg.transcriptionModel) {
      rule('6. Audio backfill');
      const inventory = await inventoryAudio(cfg);
      console.log(`  ${inventory.available} accessible audio file(s), ` +
        `${inventory.unavailable} unavailable; ` +
        `${(inventory.durationS / 3600).toFixed(1)} hours measured`);
      if (inventory.durationUnknown) {
        console.log(yellow(`  ${inventory.durationUnknown} duration(s) could not be measured; ` +
          'cost and time below are incomplete.'));
      }
      console.log(`  estimated transcription time: ~${Math.ceil(inventory.estimatedSeconds / 60)} min ` +
        '(pilot estimate; allow more for retries)');
      if (cfg.transcriptionModel === 'gpt-transcribe') {
        console.log(`  estimated audio API cost: ~$${inventory.estimatedCostUSD.toFixed(2)}`);
      }
      console.log('  Embedding cost is estimated from the actual new windows after transcription.');
      if (inventory.available && await confirm('  Iniciar transcrição agora?', false)) {
        const result = await runTranscription(cfg, {
          limit: Infinity,
          onProgress: (m) => console.log(dim(`  ${m}`)),
        });
        console.log(`  ${result.processed} transcribed, ${result.published} conversation(s) published`);
        if (cfg.openaiKey) {
          const followup = estimatePending(cfg.store, ec);
          console.log(`  ${followup.pending} new window hash(es) to embed, ` +
            `estimated $${followup.costUSD.toFixed(2)}`);
          if (followup.pending && await confirm('  Embed transcript windows now?', false)) {
            await embedMissing(cfg.store, ec);
          }
        }
      } else {
        console.log(dim('  Pending. Run `npm run wa -- transcribe` when ready.'));
      }
    }

    // --- 7. periodic sync --------------------------------------------------
    rule('7. Keeping it up to date');
    if (process.platform !== 'darwin') {
      console.log('  On Windows, import a refreshed compatible SQLite file and run `npm run sync`.');
      console.log('  The native WhatsApp Windows database is not read automatically.');
    } else {
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
    }

    // --- 8. sleep ----------------------------------------------------------
    if (process.platform === 'darwin') {
    rule('8. Sleep');
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
    }

    // --- 9. connect --------------------------------------------------------
    rule('9. Connect an AI client');
    const serverPath = join(REPO, 'src/mcp/server.ts');
    console.log('Claude Code:\n');
    console.log(dim(
      `  claude mcp add whatmcp -- node --experimental-sqlite ` +
      `--experimental-strip-types --no-warnings ${serverPath}\n`,
    ));
    console.log('Claude Desktop — add to');
    console.log(dim(process.platform === 'win32'
      ? '  %APPDATA%\\Claude\\claude_desktop_config.json\n'
      : '  ~/Library/Application Support/Claude/claude_desktop_config.json\n'));
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
    if (process.platform === 'darwin') console.log(
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
