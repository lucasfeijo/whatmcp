/**
 * Environment checks shared by `doctor` and `setup`.
 *
 * The check that matters most here is Full Disk Access, and it is worth
 * explaining why it gets this much code.
 *
 * WhatsApp's store lives in a TCC-protected group container. Reading it requires
 * the *parent process* to hold Full Disk Access — not this script, not node, but
 * whatever launched them: Terminal, iTerm, or the GUI app that spawned an MCP
 * server. macOS does not report this as a permissions error. `existsSync` returns
 * true, the path is listed, and only the actual read fails — often with
 * `EPERM: operation not permitted`, sometimes with an empty result.
 *
 * The failure is therefore silent and misattributed by default: it looks like a
 * missing file or a corrupt database rather than a privacy setting, and the fix
 * is in System Settings where nobody thinks to look. Naming it precisely, with
 * the exact app that needs the grant, is the difference between a two-minute
 * setup and giving up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { DEFAULT_CHATSTORAGE } from './config.ts';

export interface Check {
  ok: boolean;
  label: string;
  detail: string;
  /** Present when ok is false: what the user should actually do. */
  fix?: string;
}

/** Node must be new enough for node:sqlite and type stripping. */
export function checkNode(): Check {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const ok = maj > 22 || (maj === 22 && min >= 6);
  return {
    ok,
    label: 'Node runtime',
    detail: `v${process.versions.node}`,
    fix: ok
      ? undefined
      : 'WhatMCP needs Node >= 22.6 for node:sqlite and TypeScript stripping.\n' +
        'Install a newer Node (nodejs.org, nvm, or `brew install node`) and retry.',
  };
}

export function checkWhatsAppInstalled(): Check {
  const ok = existsSync('/Applications/WhatsApp.app');
  return {
    ok,
    label: 'WhatsApp Desktop',
    detail: ok ? 'installed' : 'not found in /Applications',
    fix: ok
      ? undefined
      : 'Install WhatsApp Desktop from the Mac App Store and sign in.\n' +
        'WhatMCP reads the local database that app maintains; it cannot talk to ' +
        'WhatsApp on its own.',
  };
}

/**
 * Best guess at which application needs the Full Disk Access grant.
 *
 * The grant belongs to the process that launched this one, since TCC inherits
 * down the process tree. Walking up to the responsible ancestor is the honest
 * answer, but `ps` gives us enough: the user recognises "Terminal" or "iTerm"
 * and would not recognise "node".
 */
export function likelyHostApp(): string {
  try {
    const ppid = process.ppid;
    const out = execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], {
      encoding: 'utf8',
    }).trim();
    const name = basename(out);
    // node running node tells the user nothing; walk one more level.
    if (/^node$|^npm$|^sh$|^zsh$|^bash$/.test(name)) {
      const gp = execFileSync('ps', ['-o', 'ppid=', '-p', String(ppid)], {
        encoding: 'utf8',
      }).trim();
      const outer = execFileSync('ps', ['-o', 'comm=', '-p', gp], {
        encoding: 'utf8',
      }).trim();
      return basename(outer) || name;
    }
    return name;
  } catch {
    return 'your terminal app';
  }
}

/**
 * Can we actually READ the WhatsApp store?
 *
 * Deliberately performs a real read rather than a stat. The whole point is that
 * the path is visible while the bytes are not, so anything short of opening the
 * file reports success on a machine that will fail at index time.
 */
export function checkStoreReadable(chatstorage: string): Check {
  if (!existsSync(chatstorage)) {
    return {
      ok: false,
      label: 'WhatsApp store',
      detail: `not found at ${chatstorage}`,
      fix:
        process.platform === 'darwin' && chatstorage === DEFAULT_CHATSTORAGE
          ? 'Sign in to WhatsApp Desktop at least once so it creates its local\n' +
            'database, then retry. If you use another source, set "chatstorage" in config.json.'
          : 'Provide the absolute path of a readable, compatible ChatStorage.sqlite.',
    };
  }

  try {
    // 16 bytes is enough: a readable SQLite file starts with "SQLite format 3".
    const fd = readFileSync(chatstorage, { flag: 'r' }).subarray(0, 16).toString('utf8');
    if (!fd.startsWith('SQLite format 3')) {
      return {
        ok: false,
        label: 'WhatsApp store',
        detail: 'file exists but is not a SQLite database',
        fix: 'The path in "chatstorage" does not point at ChatStorage.sqlite.',
      };
    }
    return { ok: true, label: 'WhatsApp store', detail: 'readable' };
  } catch (e) {
    if (process.platform !== 'darwin' || chatstorage !== DEFAULT_CHATSTORAGE) {
      return { ok: false, label: 'Source SQLite',
        detail: `cannot read it (${(e as Error).message.split('\n')[0]})`,
        fix: 'Check file permissions and provide a readable, compatible ChatStorage.sqlite.' };
    }
    const host = likelyHostApp();
    return {
      ok: false,
      label: 'WhatsApp store',
      detail: `cannot read it (${(e as Error).message.split('\n')[0]})`,
      fix:
        `macOS is withholding Full Disk Access.\n\n` +
        `  1. Open System Settings -> Privacy & Security -> Full Disk Access\n` +
        `  2. Enable "${host}"\n` +
        `  3. Quit "${host}" COMPLETELY (Cmd-Q, not just close the window)\n` +
        `  4. Reopen it and run this again\n\n` +
        `The grant belongs to the app that launched this process, not to node.\n` +
        `If you plan to run the MCP server from Claude Desktop, grant it there too —\n` +
        `a GUI-launched server inherits Claude Desktop's permissions, not Terminal's.`,
    };
  }
}

export function runPreflight(chatstorage: string): Check[] {
  return process.platform === 'darwin' && chatstorage === DEFAULT_CHATSTORAGE
    ? [checkNode(), checkWhatsAppInstalled(), checkStoreReadable(chatstorage)]
    : [checkNode(), checkStoreReadable(chatstorage)];
}
