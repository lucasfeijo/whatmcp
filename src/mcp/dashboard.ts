/**
 * Local web dashboard.
 *
 * A browser is a hostile client for this particular server, and the tension is
 * worth naming: /mcp deliberately rejects any request carrying an Origin header,
 * because no legitimate MCP client is a web page and that rule kills DNS
 * rebinding outright. A dashboard *is* a web page, so it cannot reuse that path
 * or that rule. It gets its own, narrower one:
 *
 *   - Token is exchanged once for an opaque session id held in memory. The token
 *     itself never sits in localStorage, in a URL, or anywhere a script can read
 *     it — the cookie is HttpOnly, so even an injected script cannot exfiltrate
 *     the session, and a server restart invalidates every session for free.
 *   - The cookie is SameSite=Strict, so a page on another origin cannot cause an
 *     authenticated request at all. A custom request header is required on top,
 *     which no cross-origin form or <img> can set.
 *   - Origin, when present, must be this exact server. The Host allowlist from
 *     the main app still applies underneath.
 *
 * All of which is why this binds to loopback and stays there.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

import type { Config } from '../config.ts';
import { invalidate } from '../store.ts';
import { isScheduledSyncPaused, runSyncProcess, syncWorkerCommand, syncTimeoutMs } from '../sync-process.ts';
import { searchHybrid, listThreads, listPeople, stats, type SearchContext } from '../search/search.ts';
import * as wa from '../whatsapp/source.ts';
import { recent, subscribe, emit } from './events.ts';
import { existsSync } from 'node:fs';

const HTML = readFileSync(join(import.meta.dirname, 'dashboard.html'), 'utf8');
const COOKIE = 'whatmcp_sid';
const SESSION_MS = 12 * 60 * 60 * 1000;

export interface DashboardDeps {
  cfg: Config;
  embedCfg: { model: string; dimensions: number; apiKey: string } | null;
  token: string;
  port: number;
}

/** sid -> expiry. In memory only: restarting the server logs everyone out. */
const sessions = new Map<string, number>();

function newSession(): string {
  const sid = randomBytes(32).toString('base64url');
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}

function validSession(sid: string | undefined): boolean {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (exp === undefined) return false;
  if (exp < Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function readCookie(req: express.Request, name: string): string | undefined {
  const raw = req.get('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function mountDashboard(app: express.Express, deps: DashboardDeps): void {
  const { cfg, embedCfg, token, port } = deps;
  const json = express.json({ limit: '64kb' });

  const ctx = (): SearchContext => ({
    storePath: cfg.store,
    embedCfg: embedCfg ?? { model: cfg.openaiModel, dimensions: cfg.openaiDims, apiKey: '' },
  });

  const selfOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);

  /**
   * The dashboard is loopback-only, enforced here rather than by deployment.
   *
   * A tunnel forwards to 127.0.0.1:PORT, so everything bound to this port is
   * reachable from the public internet the moment one is running — including a
   * login form and a browser rendering path that were designed for a local-only
   * threat model. Requiring the *Host header* to be loopback means the tunnel's
   * own hostname fails this check, so /mcp stays remotely reachable while the
   * dashboard does not, without depending on anyone configuring a proxy correctly.
   */
  function loopbackOnly(req: express.Request, res: express.Response): boolean {
    const host = (req.get('host') ?? '').split(':')[0].toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) {
      res.status(404).type('text').send('Not found.');
      return false;
    }
    return true;
  }

  /** Origin, if the browser sent one, must be this server. */
  function originOk(req: express.Request): boolean {
    const o = req.get('origin');
    return !o || selfOrigins.has(o);
  }

  /** Gate for every /api route except login. */
  function auth(req: express.Request, res: express.Response): boolean {
    if (!loopbackOnly(req, res)) return false;
    if (!originOk(req)) {
      res.status(403).json({ error: 'bad origin' });
      return false;
    }
    // No cross-origin form or image can set a custom header, so requiring one
    // means a hostile page cannot reach these endpoints even if a browser were
    // persuaded to attach the cookie.
    if (req.get('x-whatmcp') !== '1') {
      res.status(403).json({ error: 'missing X-WhatMCP header' });
      return false;
    }
    if (!validSession(readCookie(req, COOKIE))) {
      res.status(401).json({ error: 'not authenticated' });
      return false;
    }
    return true;
  }

  const loginGate: express.RequestHandler = (req, res, next) => {
    if (!loopbackOnly(req, res)) return;
    if (!originOk(req)) {
      res.status(403).json({ error: 'bad origin' });
      return;
    }
    next();
  };

  const authenticated: express.RequestHandler = (req, res, next) => {
    if (auth(req, res)) next();
  };

  app.get('/', (req, res) => {
    if (!loopbackOnly(req, res)) return;
    res.type('html').send(HTML);
  });

  app.post('/api/login', loginGate, json, (req, res) => {
    const supplied = String((req.body as any)?.token ?? '');
    if (!supplied || !safeEqual(supplied, token)) {
      console.error(`dashboard auth failure from ${req.ip} at ${new Date().toISOString()}`);
      res.status(401).json({ error: 'bad token' });
      return;
    }
    const sid = newSession();
    // No Secure flag: this is plain http on loopback, and setting Secure would
    // make the cookie silently never be sent. SameSite=Strict is the CSRF control.
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
    );
    res.json({ ok: true });
  });

  app.post('/api/logout', authenticated, (req, res) => {
    const sid = readCookie(req, COOKIE);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/stats', (req, res) => {
    if (!auth(req, res)) return;
    if (!existsSync(cfg.store)) {
      res.json({ ok: false, error: 'Archive not built yet — run npm run sync.' });
      return;
    }
    const s = stats(ctx());
    const src = wa.sourceInfo(cfg.chatstorage);

    let state: 'current' | 'behind' | 'never' = 'current';
    let detail = '';
    if (!s.last_sync_at) {
      state = 'never';
      detail = 'The archive has never been synced.';
    } else if (cfg.sourceType === 'windows-waren6') {
      detail = `Windows snapshot last synced ${new Date(s.last_sync_at * 1000).toLocaleString()}; WhatsApp remains open during hot copy.`;
    } else if (!src.exists) {
      detail = 'WhatsApp Desktop store not found on this Mac.';
    } else if (src.mtime > s.last_sync_at) {
      state = 'behind';
      const behind = src.mtime - s.last_sync_at;
      const hours = behind / 3600;
      const ago =
        hours < 1 ? `${Math.round(behind / 60)} min`
        : hours < 48 ? `${Math.round(hours)} hours`
        : `${Math.round(hours / 24)} days`;
      detail = `WhatsApp has been active ${ago} more recently than the last sync.`;
    } else {
      detail = `Last synced ${new Date(s.last_sync_at * 1000).toLocaleString()}.`;
    }

    if (isScheduledSyncPaused()) {
      state = 'behind';
      detail += ' Scheduled sync is paused after a timeout; run a manual sync to retry.';
    }

    res.json({
      ok: true,
      store: cfg.store,
      stats: s,
      freshness: { state, detail },
      chats: listThreads(ctx(), { limit: 8 }).sort((a, b) => b.msg_count - a.msg_count),
      people: listPeople(ctx(), { limit: 8 }),
    });
  });

  app.get('/api/search', async (req, res) => {
    if (!auth(req, res)) return;
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ hits: [], strongCount: 0, degraded: null });
      return;
    }
    if (!existsSync(cfg.store)) {
      res.json({ error: 'Archive not built yet — run npm run sync.' });
      return;
    }
    try {
      const out = await searchHybrid(ctx(), {
        query: q,
        limit: 10,
        minSim: cfg.minSim,
        strongSim: cfg.strongSim,
        mode: embedCfg ? 'hybrid' : 'bm25',
      });
      res.json(out);
    } catch (e) {
      res.json({ error: (e as Error).message });
    }
  });

  /*
   * Live activity stream.
   *
   * NDJSON over a long-lived response rather than EventSource, for one concrete
   * reason: EventSource cannot set request headers, and every /api route here
   * requires the X-WhatMCP header as its CSRF control. Using fetch + a stream
   * reader keeps that control intact instead of carving an exception into it.
   */
  app.get('/api/logs/stream', (req, res) => {
    if (!auth(req, res)) return;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    // Replay recent history first, so the panel is populated on open rather than
    // blank until something happens to occur.
    for (const e of recent(80)) res.write(JSON.stringify(e) + '\n');

    const unsubscribe = subscribe((e) => {
      try { res.write(JSON.stringify(e) + '\n'); } catch { /* client went away */ }
    });

    // Proxies and browsers drop idle connections; a periodic newline is cheap and
    // keeps the stream open through cloudflared without any protocol ceremony.
    const keepalive = setInterval(() => {
      try { res.write('\n'); } catch { /* ignore */ }
    }, 20_000);

    const close = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  });

  /*
   * One sync at a time.
   *
   * Two concurrent runs would open the same SQLite file for writing and race on
   * the window rebuild. A 409 is the honest answer — silently queueing would make
   * the button look broken while the first run finished.
   */
  let syncing = false;

  app.post('/api/sync', authenticated, json, async (req, res) => {
    if (syncing) {
      res.status(409).json({ error: 'a sync is already running' });
      return;
    }
    if (!embedCfg) {
      res.status(400).json({ error: 'no OpenAI key configured' });
      return;
    }

    syncing = true;
    const full = !!(req.body as any)?.full;

    // Newline-delimited JSON on an open response, so a long first-run embed
    // reports progress instead of looking hung behind a spinner.
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (msg: string) => res.write(JSON.stringify({ msg }) + '\n');

    try {
      const [command, args] = syncWorkerCommand(full);
      const timeoutMs = syncTimeoutMs(cfg.sourceType);
        const code = await runSyncProcess(command, args, {
          timeoutMs,
        onOutput: (chunk) => emit(chunk.trimEnd()),
      });
      invalidate(); // a failed child may still have indexed some messages
      if (code !== 0) throw new Error(code === 124
        ? `sync exceeded ${timeoutMs / 60000} minutes; scheduled sync is paused until a manual sync succeeds`
        : code === 75
          ? 'another sync is already running; this request was skipped'
        : `sync exited with code ${code}`);

      const s = stats(ctx());
      emit(`done — ${s.messages} message(s) across ${s.threads} chat(s)`);
    } catch (err) {
      emit(`failed: ${(err as Error).message}`);
    } finally {
      syncing = false;
      res.end();
    }
  });
}
