import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { CHARACTER_TOOLS, type Character } from '../bank/tools.js';
import type { SayOptions, TurnResult } from '../game/engine.js';
import { GameError } from '../game/errors.js';
import { RateLimiter } from '../game/ratelimit.js';
import { type ApiEvent, type Role, liveEvent, replyEvent } from './events.js';

/** The part of a game the API needs. The real one is `Game`; tests supply a stand-in. */
export interface GameLike {
  readonly id: string;
  identity: string;
  readonly unlocked: ReadonlySet<Character>;
  readonly customer?: { name: string; account: string };
  wear?(role: Role, identity: string): Promise<void>;
  say(character: Character, text: string, opts?: SayOptions): Promise<TurnResult>;
  summary(): { cleared: number[]; turns: number; rank: string };
  close(): Promise<void>;
}

export const API_LIMITS = {
  maxGames: 20,
  gameIdleMs: 30 * 60 * 1000,
  gamesPerIpPerHour: 6,
  /** Across all players. This is what protects the model providers' free quotas. */
  turnsPerMinute: 30,
};

/** Character voices: starts a line and serves its audio. */
export interface VoiceDeps {
  readonly enabled: boolean;
  start(character: string, text: string, mood?: TurnResult['mood']): string | undefined;
  warm?(): void;
  pipe(id: string, res: Response): void;
}

export interface ApiDeps {
  voice?: VoiceDeps;
  newGame(identity: string, name?: string): Promise<GameLike>;
  identityFor(role: Role): string;
  /** When set, starting a game needs this code. Leave unset for local play. */
  accessCode?: string;
  corsOrigin?: string;
  limits?: Partial<typeof API_LIMITS>;
  now?: () => number;
}

const role = z.enum(['customer', 'manager']);
const startBody = z.object({ role: role.default('customer'), name: z.string().trim().max(40).optional(), code: z.string().max(100).optional() });
const sayBody = z.object({ character: z.enum(Object.keys(CHARACTER_TOOLS) as [Character, ...Character[]]), text: z.string().trim().min(1).max(1500), /** False when the player has sound off: no credits are spent on a line nobody hears. */ voice: z.boolean().optional() });
const roleBody = z.object({ role });

const STATUS: Partial<Record<GameError['code'], number>> = { BAD_INPUT: 400, LOCKED: 409, BUSY: 409, RATE_LIMITED: 429, TURN_BUDGET: 409, TIMEOUT: 504, MODEL_UNAVAILABLE: 503, MODEL_QUOTA: 503, WORLD_UNAVAILABLE: 503 };

interface Entry {
  game: GameLike;
  role: Role;
  name: string;
  touched: number;
}

export function mountApi(app: Express, deps: ApiDeps): { games: Map<string, Entry> } {
  const limits = { ...API_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const games = new Map<string, Entry>();
  const perIp = new Map<string, RateLimiter>();
  const turns = new RateLimiter(limits.turnsPerMinute, 60_000, now);

  const fail = (res: Response, status: number, code: string, message: string, retryAfterMs?: number) => {
    res.status(status).json({ error: { code, message, retryAfterMs } });
  };

  const sweep = () => {
    const t = now();
    for (const [id, e] of games) {
      if (t - e.touched > limits.gameIdleMs) {
        games.delete(id);
        void e.game.close().catch(() => undefined);
      }
    }
  };

  const find = (req: Request, res: Response): Entry | undefined => {
    const entry = games.get(String(req.params.id));
    if (!entry) fail(res, 404, 'NO_SUCH_GAME', 'That game has ended or never existed. Start a new one.');
    else entry.touched = now();
    return entry;
  };

  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // CORS_ORIGIN may list several sites, comma-separated (the game's domain and a preview address).
    const allowed = (deps.corsOrigin ?? '*').split(',').map((o) => o.trim()).filter(Boolean);
    const origin = req.header('origin');
    if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && allowed.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-access-code');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });

  app.get('/api/health', (_req, res) => {
    sweep();
    res.json({ ok: true, games: games.size, needsCode: Boolean(deps.accessCode) });
  });

  app.post('/api/game', async (req, res) => {
    const body = startBody.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, 'BAD_INPUT', body.error.issues[0]?.message ?? 'Bad request.');
    if (deps.accessCode && (req.header('x-access-code') ?? body.data.code) !== deps.accessCode) return fail(res, 401, 'BAD_CODE', 'That access code is not right.');

    const ip = req.ip ?? 'unknown';
    const limiter = perIp.get(ip) ?? new RateLimiter(limits.gamesPerIpPerHour, 60 * 60 * 1000, now);
    perIp.set(ip, limiter);
    const wait = limiter.take();
    if (wait > 0) return fail(res, 429, 'RATE_LIMITED', 'Too many games started from here. Try again later.', wait);

    sweep();
    if (games.size >= limits.maxGames) return fail(res, 503, 'FULL', 'The bank is full tonight. Try again in a few minutes.');

    try {
      const game = await deps.newGame(deps.identityFor(body.data.role), body.data.name);
      // A game started under the manager badge must tell the bank, exactly as switching to it later does.
      if (body.data.role === 'manager') await game.wear?.('manager', deps.identityFor('manager'));
      games.set(game.id, { game, role: body.data.role, name: body.data.name || 'Stranger', touched: now() });
      res.status(201).json({ gameId: game.id, role: body.data.role, name: body.data.name || 'Stranger', customer: game.customer, unlocked: [...game.unlocked] });
    } catch (err) {
      const e = err instanceof GameError ? err : new GameError('INTERNAL', 'Could not open the bank.');
      fail(res, STATUS[e.code] ?? 500, e.code, e.message, e.retryAfterMs);
    }
  });

  // One player line in, a stream of events out: each tool call, each ArmorIQ decision, then the reply.
  app.get('/api/voice/:id', (req, res) => {
    if (!deps.voice || !/^[\w-]{36}$/.test(String(req.params.id))) return void res.status(404).end();
    deps.voice.pipe(String(req.params.id), res);
  });

  app.post('/api/game/:id/say', async (req, res) => {
    const entry = find(req, res);
    if (!entry) return;
    const body = sayBody.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, 'BAD_INPUT', body.error.issues[0]?.message ?? 'Bad request.');
    const wait = turns.take();
    if (wait > 0) return fail(res, 429, 'RATE_LIMITED', 'The bank is busy. Give it a moment.', wait);

    if (deps.voice?.enabled && body.data.voice !== false) deps.voice.warm?.();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: ApiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    // A held action can wait minutes for a person; comments keep proxies from closing the stream.
    const beat = setInterval(() => res.write(': waiting\n\n'), 15_000);
    try {
      const result = await entry.game.say(body.data.character, body.data.text, {
        onEvent: (e) => {
          const out = liveEvent(e);
          if (out) send(out);
        },
      });
      // Speech starts now, before the reply is even sent, so the first audio is close behind the text.
      const speak = deps.voice?.enabled && body.data.voice !== false;
      const audio = speak ? deps.voice!.start(result.character, result.reply, result.mood) : undefined;
      const delegateAudio = speak && result.delegate ? deps.voice!.start('junior-teller', result.delegate.reply) : undefined;
      send(replyEvent(result, { audioUrl: audio && `/api/voice/${audio}`, delegateAudioUrl: delegateAudio && `/api/voice/${delegateAudio}` }));
    } catch (err) {
      if (err instanceof GameError) send({ type: 'error', code: err.code, message: err.message, retryAfterMs: err.retryAfterMs });
      else {
        console.error('[api] turn failed', err);
        send({ type: 'error', code: 'INTERNAL', message: 'Something went wrong at the bank. Try that again.' });
      }
    } finally {
      clearInterval(beat);
      entry.touched = now();
      res.end();
    }
  });

  app.post('/api/game/:id/role', async (req, res) => {
    const entry = find(req, res);
    if (!entry) return;
    const body = roleBody.safeParse(req.body ?? {});
    if (!body.success) return fail(res, 400, 'BAD_INPUT', 'role must be customer or manager.');
    const identity = deps.identityFor(body.data.role);
    try {
      if (entry.game.wear) await entry.game.wear(body.data.role, identity); else entry.game.identity = identity;
    } catch {
      return fail(res, 503, 'WORLD_UNAVAILABLE', 'The bank could not be reached. Try again.');
    }
    entry.role = body.data.role;
    res.json({ role: entry.role });
  });

  app.get('/api/game/:id/summary', (req, res) => {
    const entry = find(req, res);
    if (!entry) return;
    res.json({ ...entry.game.summary(), role: entry.role, name: entry.name, unlocked: [...entry.game.unlocked] });
  });

  app.delete('/api/game/:id', (req, res) => {
    const entry = games.get(String(req.params.id));
    if (entry) {
      games.delete(entry.game.id);
      void entry.game.close().catch(() => undefined);
    }
    res.status(204).end();
  });

  return { games };
}
