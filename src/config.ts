/**
 * Configuration resolution.
 *
 * The load-bearing detail here is where the OpenAI key comes from. An MCP server
 * launched by Claude Desktop is spawned by a GUI app, not by your shell — it
 * inherits none of your shell environment, so `export OPENAI_API_KEY=...` in
 * .zshrc is invisible to it. A config file is the only mechanism that works for
 * both stdio-under-a-GUI and a plain terminal run, so the file is the primary
 * source and the environment is an override for scripted use.
 *
 * The archive lives in ~/.whatmcp, deliberately outside this repo. It is meant to
 * outlive the code: WhatsApp Desktop prunes its own local store, so after a while
 * this archive holds messages that exist nowhere else on the machine. Deleting a
 * checkout should not delete nine years of history.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = process.env.WHATMCP_HOME ?? join(homedir(), '.whatmcp');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_STORE = join(DATA_DIR, 'archive.db');

/** WhatsApp Desktop's Core Data store. */
export const DEFAULT_CHATSTORAGE = join(
  homedir(),
  'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite',
);

export interface FileConfig {
  openai_api_key?: string;
  openai_model?: string;
  openai_dims?: number;
  store?: string;
  chatstorage?: string;
  /** Source for future syncs; the iPhone backup remains in the archive. */
  source_type?: 'chatstorage' | 'windows-waren6';
  /** WAren6 checkout or Field Kit directory; never contains a credential. */
  windows_waren6_path?: string;
  /** Private directory for WAren6 cases; not inside the Git checkout. */
  windows_output_dir?: string;
  /** Explicit live package directory for service accounts. */
  windows_source_path?: string;
  /** Background sync cadence in hours; 0 or absent means manual only. */
  sync_interval_hours?: number;
  /** Written by `wa calibrate`; see search.ts for why these are not constants. */
  min_sim?: number;
  strong_sim?: number;

  // --- HTTP transport (optional; stdio needs none of this) ---
  /** Bearer token. Full read access to the entire archive — treat as a password. */
  http_token?: string;
  http_port?: number;
  /** Default 127.0.0.1. Anything else means unencrypted traffic off-machine. */
  http_host?: string;
  /** Extra Host header values to accept, for a tunnel's public hostname. */
  http_allowed_hosts?: string[];
  /** Host suffixes to accept, e.g. ".trycloudflare.com" for rotating quick tunnels. */
  http_allowed_host_suffixes?: string[];
  /** Browser origins to accept. Empty means "no browser may call this". */
  http_allowed_origins?: string[];
  /**
   * Stable public origin, e.g. https://whatmcp.example.com. OAuth issuer and
   * redirect URLs are built from it. Leave unset only with a rotating tunnel,
   * where it is derived per request instead.
   */
  public_url?: string;
}

export function ensureDataDir(): string {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  chmodSync(DATA_DIR, 0o700);
  return DATA_DIR;
}

export function readFileConfig(): FileConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as FileConfig;
  } catch (e) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON (${(e as Error).message}).\n` +
        `Fix or delete it, then run: npm run wa -- set-key`,
    );
  }
}

/**
 * Persist config. Written 0600 and re-chmod'd on every write, because this file
 * holds an API key and an inherited 0644 from a previous version would otherwise
 * survive forever.
 */
export function writeFileConfig(patch: FileConfig): void {
  ensureDataDir();
  const merged = { ...readFileConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

export interface Config {
  store: string;
  chatstorage: string;
  sourceType: 'chatstorage' | 'windows-waren6';
  windowsWaren6Path: string | null;
  windowsOutputDir: string;
  windowsSourcePath?: string;
  openaiKey: string | null;
  openaiModel: string;
  openaiDims: number;
  /** Undefined means "use the code default"; set by `wa calibrate`. */
  minSim?: number;
  strongSim?: number;
  /** Background sync cadence in hours; 0 means manual only. */
  syncIntervalHours: number;
}

export const NATIVE_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export function loadConfig(): Config {
  const f = readFileConfig();
  const model = process.env.WHATMCP_OPENAI_MODEL ?? f.openai_model ?? 'text-embedding-3-small';
  const dims = Number(
    process.env.WHATMCP_OPENAI_DIMS ?? f.openai_dims ?? NATIVE_DIMS[model] ?? 1536,
  );
  return {
    store: process.env.WHATMCP_STORE ?? f.store ?? DEFAULT_STORE,
    chatstorage: process.env.WHATMCP_CHATSTORAGE ?? f.chatstorage ?? DEFAULT_CHATSTORAGE,
    sourceType: process.env.WHATMCP_SOURCE_TYPE === 'windows-waren6' ? 'windows-waren6'
      : process.env.WHATMCP_SOURCE_TYPE === 'chatstorage' ? 'chatstorage'
      : f.source_type ?? 'chatstorage',
    windowsSourcePath: process.env.WHATMCP_WINDOWS_SOURCE_PATH ?? f.windows_source_path,
    windowsWaren6Path: process.env.WHATMCP_WAREN6_PATH ?? f.windows_waren6_path ?? null,
    windowsOutputDir: process.env.WHATMCP_WINDOWS_OUTPUT_DIR ?? f.windows_output_dir ?? join(DATA_DIR, 'windows-cases'),
    openaiKey: process.env.OPENAI_API_KEY ?? f.openai_api_key ?? null,
    openaiModel: model,
    openaiDims: dims,
    minSim: f.min_sim,
    strongSim: f.strong_sim,
    syncIntervalHours: Number(f.sync_interval_hours ?? 0),
  };
}

/** The shape the embedder and search layer both take. */
export function embedConfig(cfg: Config = loadConfig()): {
  model: string;
  dimensions: number;
  apiKey: string;
} {
  return { model: cfg.openaiModel, dimensions: cfg.openaiDims, apiKey: requireKey(cfg) };
}

/**
 * The key, or a failure that says exactly how to fix it.
 *
 * Worth being loud: without a key the vector arm silently disappears and search
 * quietly degrades to keyword-only. That is a real answer-quality change and must
 * never happen by accident.
 */
export function requireKey(cfg: Config = loadConfig()): string {
  if (!cfg.openaiKey) {
    throw new Error(
      'No OpenAI API key configured.\n' +
        `Run:  npm run wa -- set-key\n` +
        `(stored 0600 in ${CONFIG_PATH}; never logged, never written to the archive)`,
    );
  }
  return cfg.openaiKey;
}

/** Never print a key. Used in doctor output. */
export function maskKey(k: string | null): string {
  if (!k) return 'not set';
  return k.length <= 10 ? 'set' : `${k.slice(0, 6)}…${k.slice(-4)}`;
}
