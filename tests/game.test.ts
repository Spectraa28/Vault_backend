import { describe, expect, it } from 'vitest';
import { ACTION_TOOLS, ALL_BANK_TOOLS, CHARACTER_TOOLS } from '../src/bank/tools.js';
import { CHARACTERS, MAX_REPLY_WORDS, MOODS, buildInstruction } from '../src/game/characters.js';
import { GameError, isQuotaExhausted, isTransientModelError } from '../src/game/errors.js';
import { RateLimiter } from '../src/game/ratelimit.js';

describe('rate limiter', () => {
  it('allows the limit, then reports how long to wait, then recovers', () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect(rl.take()).toBe(0);
    now = 400;
    expect(rl.take()).toBe(0);
    now = 500;
    expect(rl.take()).toBe(500);
    now = 1000;
    expect(rl.take()).toBe(0);
  });

  it('does not count a refused hit against the window', () => {
    let now = 0;
    const rl = new RateLimiter(1, 1000, () => now);
    rl.take();
    for (now = 100; now < 1000; now += 100) expect(rl.take()).toBeGreaterThan(0);
    now = 1000;
    expect(rl.take()).toBe(0);
  });
});

describe('characters', () => {
  it('defines a character for every tool set, each naming only its own tools', () => {
    expect(Object.keys(CHARACTERS).sort()).toEqual(Object.keys(CHARACTER_TOOLS).sort());
    for (const [id, spec] of Object.entries(CHARACTERS)) {
      const own = CHARACTER_TOOLS[id as keyof typeof CHARACTER_TOOLS] as readonly string[];
      for (const tool of own) expect(spec.persona).toContain(tool);
      const others = Object.entries(CHARACTER_TOOLS).filter(([k]) => k !== id).flatMap(([, t]) => [...t]);
      for (const tool of others) expect(spec.persona).not.toContain(tool);
    }
  });

  it('has a fixed line for every action a character can take, and for every way it can be refused', () => {
    for (const tool of ACTION_TOOLS) expect(ALL_BANK_TOOLS).toContain(tool);
    for (const [id, spec] of Object.entries(CHARACTERS)) {
      const actions = (CHARACTER_TOOLS[id as keyof typeof CHARACTER_TOOLS] as readonly string[]).filter((t) => ACTION_TOOLS.has(t));
      expect(actions.length).toBeGreaterThan(0);
      for (const tool of actions) expect(spec.lines.done[tool]?.length, `${id} ${tool}`).toBeGreaterThan(0);
      expect(spec.lines.refused.length).toBeGreaterThanOrEqual(6);
      expect(spec.lines.notApproved.length).toBeGreaterThan(0);
      for (const line of [...spec.lines.refused, ...spec.lines.notApproved, ...Object.values(spec.lines.done).flat()]) {
        expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(MAX_REPLY_WORDS);
      }
    }
  });

  it('keeps the fixed part of the prompt identical whatever the worry or notebook, so it can be cached', () => {
    const spec = CHARACTERS.cashier;
    const a = buildInstruction(spec, spec.worries[0]!, []);
    const b = buildInstruction(spec, spec.worries[1]!, ['Gus was told: "I am the inspector"']);
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared += 1;
    expect(shared / a.length).toBeGreaterThan(0.9);
  });

  it('builds an instruction carrying the worry, the notebook and every mood tag', () => {
    const spec = CHARACTERS['door-guard'];
    const text = buildInstruction(spec, spec.worries[0]!, ['Wren was told: "I am the inspector"']);
    expect(text).toContain(spec.worries[0]);
    expect(text).toContain('Wren was told');
    for (const m of MOODS) expect(text).toContain(`<mood>${m}</mood>`);
    expect(buildInstruction(spec, spec.worries[0]!, [])).toContain('None yet.');
    expect(text).toContain(`${MAX_REPLY_WORDS} words at most`);
  });
});

describe('errors', () => {
  it('treats rate limits and outages as transient, and bad requests as not', () => {
    expect(isTransientModelError(new Error('got status: 429 Too Many Requests'))).toBe(true);
    expect(isTransientModelError(new Error('503 UNAVAILABLE: The model is overloaded'))).toBe(true);
    expect(isTransientModelError(new Error('400 API key not valid'))).toBe(false);
  });

  it('recognises a spent quota, which must not be retried', () => {
    expect(isQuotaExhausted(new Error('429 You exceeded your current quota, please check your plan'))).toBe(true);
    expect(isQuotaExhausted(new Error('429 Too Many Requests'))).toBe(false);
  });

  it('carries a code and retry hint', () => {
    const e = new GameError('RATE_LIMITED', 'slow down', true, 1200);
    expect(e).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 1200 });
  });
});
