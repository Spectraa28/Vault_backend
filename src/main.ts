/**
 * The whole back end in one process: the bank's MCP server and the game API.
 *
 *   npm start
 *
 * The game talks to the bank over MCP at MCP_URL, which by default is this same process.
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { mountApi } from './api/routes.js';
import { loadConfig } from './config.js';
import { GameHost } from './game/engine.js';
import { createApp } from './mcp/server.js';

const port = Number(process.env.PORT ?? 8787);
const cfg = loadConfig(process.env.MCP_URL ? {} : { MCP_URL: `http://127.0.0.1:${port}/mcp` });
const app = createApp();
app.set('trust proxy', 1);

const host = new GameHost(cfg);
mountApi(app, {
  newGame: (identity, name) => host.newGame({ identity, name }),
  identityFor: (role) => (role === 'manager' ? cfg.USER_EMAIL : (cfg.PLAYER_EMAIL ?? cfg.USER_EMAIL)),
  accessCode: cfg.GAME_ACCESS_CODE,
  corsOrigin: cfg.CORS_ORIGIN,
});

// When the front end has been built, serve it too, so one service is the whole game.
const site = resolve('frontend/dist');
if (existsSync(site)) {
  app.use(express.static(site, { index: 'index.html', maxAge: '1h', setHeaders: (res, path) => { if (path.includes('/assets/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable'); } }));
  app.get(/^\/(?!api\/|bank\/|mcp).*/, (_req, res) => res.sendFile(resolve(site, 'index.html')));
}

const server = app.listen(port, () => {
  console.log(`The Vault back end on :${port}  (API /api, bank MCP /bank/mcp)${cfg.GAME_ACCESS_CODE ? '' : '  — no access code set, anyone can start a game'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => void host.close().finally(() => process.exit(0)));
  });
}
