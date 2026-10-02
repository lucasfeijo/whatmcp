import https from 'node:https';
import http from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.WHATMCP_HOME ?? fileURLToPath(new URL('../../data/', import.meta.url));
process.env.WHATMCP_HOME = home;
console.error = (...args) => appendFileSync(join(home, 'logs/https-server.log'), `${new Date().toISOString()} ${args.join(' ')}\n`);
const tls = JSON.parse(readFileSync(join(home, 'tls-runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
process.env.WHATMCP_HTTP_HOST = '127.0.0.1';
process.env.WHATMCP_HTTP_PORT = '8786';
process.env.WHATMCP_NO_DASHBOARD = '1';
await import('../src/mcp/http.ts');

const gateway = https.createServer({
  pfx: readFileSync(tls.pfx_path), passphrase: tls.pfx_password,
  minVersion: 'TLSv1.2',
}, (req, res) => {
  const pathname = new URL(req.url, 'https://localhost').pathname;
  if (pathname !== '/mcp' && pathname !== '/health') {
    res.writeHead(404).end();
    return;
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: 8786, method: req.method, path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:8786' },
  }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
gateway.headersTimeout = 60000;
gateway.keepAliveTimeout = 65000;
gateway.listen(8787, '0.0.0.0', () => console.error('WhatMCP HTTPS ready on port 8787'));
