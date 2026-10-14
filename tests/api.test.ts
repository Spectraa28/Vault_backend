import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiEvent } from '../src/api/events.js';
import { eventsFromTurn } from '../src/api/events.js';
import { type GameLike, mountApi } from '../src/api/routes.js';
import type { Character } from '../src/bank/tools.js';
import type { SayOptions, TurnResult } from '../src/game/engine.js';
import { GameError } from '../src/game/errors.js';

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({ turnId: 't', character: 'vault-guard', name: 'Marlowe', reply: "She won't budge.", mood: 'curious', trust: 5, attempts: [], model: 'fake', tokens: { prompt: 0, cached: 0, output: 0 }, unlocked: [], cleared: [], enforcementHeld: true, ms: 5, ...over });

class FakeGame implements GameLike {
  identity: string;
  unlocked = new Set<Character>(['door-guard']);
  closed = false;
  badges: string[] = [];
  async wear(role: 'customer' | 'manager', identity: string) { this.badges.push(role); this.identity = identity; }
  said: { character: Character; text: string; as: string }[] = [];
  next: (opts?: SayOptions) => Promise<TurnResult> = async () => turn();
  constructor(readonly id: string, identity: string) {
    this.identity = identity;
  }
  say(character: Character, text: string, opts?: SayOptions) {
    this.said.push({ character, text, as: this.identity });
    return this.next(opts);
  }
  summary() {
    return { cleared: [1], turns: this.said.length, rank: 'Chancer' };
  }
  async close() {
    this.closed = true;
  }
}

let server: ReturnType<express.Express['listen']> | undefined;
afterEach(() => server?.close());

function start(over: Partial<Parameters<typeof mountApi>[1]> = {}) {
  const app = express();
  app.use(express.json());
  const made: FakeGame[] = [];
  let now = 1_000_000;
  const api = mountApi(app, {
    newGame: async (identity) => {
      const g = new FakeGame(`game-${made.length + 1}`, identity);
      made.push(g);
      return g;
    },
    identityFor: (role) => `${role}@bank.test`,
    now: () => now,
    ...over,
  });
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  const stream = async (path: string, body: unknown): Promise<ApiEvent[]> => {
    const text = await (await post(path, body)).text();
    return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as ApiEvent);
  };
  return { base, post, stream, made, api, advance: (ms: number) => (now += ms) };
}

describe('game API', () => {
  it('starts a game as the chosen role and reports who can be talked to', async () => {
    const { post, made } = start();
    const res = await post('/api/game', { role: 'manager', name: 'Ada' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ gameId: 'game-1', role: 'manager', name: 'Ada', unlocked: ['door-guard'] });
    expect(made[0]!.identity).toBe('manager@bank.test');
    // The bank must hear about the badge from the start, or the guest list calls the staff card a fake.
    expect(made[0]!.badges).toEqual(['manager']);
    await post('/api/game', { role: 'customer', name: 'Bo' });
    expect(made[1]!.badges).toEqual([]);
  });

  it('starts the character speaking with the reply, and spends nothing when the player has sound off', async () => {
    const started: string[] = [];
    const voice = { enabled: true, start: (character: string, text: string) => { started.push(`${character}: ${text}`); return '00000000-0000-0000-0000-000000000001'; }, pipe: () => undefined };
    const { post, stream } = start({ voice });
    await post('/api/game', {});
    const loud = (await stream('/api/game/game-1/say', { character: 'door-guard', text: 'Evening.' })).at(-1)!;
    expect(loud).toMatchObject({ type: 'reply', audioUrl: '/api/voice/00000000-0000-0000-0000-000000000001' });
    expect(started).toHaveLength(1);
    const quiet = (await stream('/api/game/game-1/say', { character: 'door-guard', text: 'Evening.', voice: false })).at(-1)!;
    expect(quiet).not.toHaveProperty('audioUrl');
    expect(started).toHaveLength(1);
  });

  it('streams tool, hold, decision and reply in order, without leaking identities', async () => {
    const { post, stream, made } = start();
    await post('/api/game', {});
    made[0]!.next = async (opts) => {
      opts?.onEvent?.({ type: 'tool', tool: 'withdraw_cash', args: { amount: 100 } });
      opts?.onEvent?.({ type: 'hold', tool: 'withdraw_cash', reason: 'rule_action_hold' });
      opts?.onEvent?.({ type: 'approved', tool: 'withdraw_cash' });
      opts?.onEvent?.({ type: 'decision', tool: 'withdraw_cash', decision: 'approved' });
      return turn({ name: 'Wren', cleared: [3], attempts: [{ tool: 'withdraw_cash', args: { amount: 100 }, decision: 'approved', wasHeld: true, identity: 'customer@bank.test', executed: true }] });
    };
    const events = await stream('/api/game/game-1/say', { character: 'cashier', text: 'One hundred, please.' });
    expect(events.map((e) => e.type)).toEqual(['tool', 'hold', 'decision', 'reply']);
    const reply = events.at(-1)!;
    expect(reply).toMatchObject({ type: 'reply', name: 'Wren', cleared: [3], coldShoulder: false, enforcementHeld: true });
    expect(JSON.stringify(events)).not.toContain('@bank.test');
    expect(made[0]!.said[0]).toEqual({ character: 'cashier', text: 'One hundred, please.', as: 'customer@bank.test' });
  });

  it('reports a game error inside the stream', async () => {
    const { post, stream, made } = start();
    await post('/api/game', {});
    made[0]!.next = async () => {
      throw new GameError('LOCKED', "You can't reach Wren yet.");
    };
    expect(await stream('/api/game/game-1/say', { character: 'cashier', text: 'hi' })).toEqual([{ type: 'error', code: 'LOCKED', message: "You can't reach Wren yet." }]);
  });

  it('switches role, and the next line is judged as that identity', async () => {
    const { post, stream, made } = start();
    await post('/api/game', {});
    expect(await (await post('/api/game/game-1/role', { role: 'manager' })).json()).toEqual({ role: 'manager' });
    await stream('/api/game/game-1/say', { character: 'door-guard', text: 'Evening.' });
    expect(made[0]!.said[0]!.as).toBe('manager@bank.test');
  });

  it('rejects bad input and unknown games before opening a stream', async () => {
    const { post } = start();
    await post('/api/game', {});
    expect((await post('/api/game/game-1/say', { character: 'the-mayor', text: 'hi' })).status).toBe(400);
    expect((await post('/api/game/game-1/say', { character: 'cashier', text: '   ' })).status).toBe(400);
    expect((await post('/api/game/nope/say', { character: 'cashier', text: 'hi' })).status).toBe(404);
    expect((await post('/api/game/game-1/role', { role: 'director' })).status).toBe(400);
  });

  it('needs the access code when one is set', async () => {
    const { post } = start({ accessCode: 'brass-key' });
    expect((await post('/api/game', {})).status).toBe(401);
    expect((await post('/api/game', { code: 'wrong' })).status).toBe(401);
    expect((await post('/api/game', {}, { 'x-access-code': 'brass-key' })).status).toBe(201);
  });

  it('caps games per address, total games and turns per minute', async () => {
    const perIp = start({ limits: { gamesPerIpPerHour: 2 } });
    await perIp.post('/api/game', {});
    await perIp.post('/api/game', {});
    expect((await perIp.post('/api/game', {})).status).toBe(429);
    server?.close();

    const full = start({ limits: { maxGames: 1 } });
    await full.post('/api/game', {});
    expect((await full.post('/api/game', {})).status).toBe(503);
    server?.close();

    const busy = start({ limits: { turnsPerMinute: 1 } });
    await busy.post('/api/game', {});
    await busy.stream('/api/game/game-1/say', { character: 'door-guard', text: 'hi' });
    expect((await busy.post('/api/game/game-1/say', { character: 'door-guard', text: 'hi' })).status).toBe(429);
  });

  it('closes and forgets games left idle', async () => {
    const { post, made, advance, base } = start({ limits: { gameIdleMs: 1000 } });
    await post('/api/game', {});
    advance(5000);
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ games: 0 });
    expect(made[0]!.closed).toBe(true);
    expect((await fetch(`${base}/api/game/game-1/summary`)).status).toBe(404);
  });

  it('answers a browser preflight', async () => {
    const { base } = start({ corsOrigin: 'https://vault.example' });
    const res = await fetch(`${base}/api/game`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://vault.example');
  });
});

describe('mock events', () => {
  it('rebuilds the stream a finished turn would have produced', () => {
    const events = eventsFromTurn(turn({ attempts: [{ tool: 'open_vault', args: { confirm: true }, decision: 'blocked', layer: 'policy', reason: 'tool_not_in_allowlist', identity: 'x@y.test', executed: false }] }));
    expect(events.map((e) => e.type)).toEqual(['tool', 'decision', 'reply']);
    expect(JSON.stringify(events)).not.toContain('x@y.test');
  });
});
