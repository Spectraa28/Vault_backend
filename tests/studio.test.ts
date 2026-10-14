import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTION_TOOLS, ALL_BANK_TOOLS } from '../src/bank/tools.js';
import { PolicyStudio } from '../src/armortools/studio.js';
import { canonicalPolicyHash, validatePolicyIr } from '../src/armortools/vendor/policy-ir.mjs';

const policy = JSON.parse(readFileSync('armoriq/policy-studio.json', 'utf8'));

function studio(reply: () => Response | Promise<Response>, ttlMs = 15_000) {
  let calls = 0, now = 0;
  const s = new PolicyStudio({ backendUrl: 'https://tools.example/', apiKey: 'k', mcpServer: 'bank-mcp', ttlMs, now: () => now, fetch: (async () => { calls += 1; return reply(); }) as typeof fetch });
  return { s, calls: () => calls, advance: (ms: number) => (now += ms) };
}
const published = () => Response.json({ version: 3, policy });

describe('the bank policy file', () => {
  it("passes ArmorIQ's own validator", () => {
    const checked = validatePolicyIr(policy);
    expect(checked.errors).toEqual([]);
    expect(canonicalPolicyHash(policy)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names every bank tool exactly once, and denies whatever it does not name', () => {
    const named = policy.statements.flatMap((s: { action: { eq?: string; in?: string[] } }) => (s.action.in ?? [s.action.eq])).map((n: string) => n.replace('mcp__bank-mcp__', ''));
    expect([...named].sort()).toEqual([...ALL_BANK_TOOLS].sort());
    expect(policy.defaults.decision).toBe('deny');
  });
});

describe('Policy Studio gate', () => {
  it('permits lookups, holds cash, and forbids the doors, the wire and the vault', async () => {
    const { s } = studio(published);
    expect(await s.verdict('check_balance', {})).toMatchObject({ effect: 'permit', version: 3, rule: 'staff-may-look-things-up' });
    expect(await s.verdict('open_public_entrance', {})).toMatchObject({ effect: 'permit' });
    expect(await s.verdict('withdraw_cash', { amount: 100 })).toMatchObject({ effect: 'require_approval', rule: 'cash-over-the-counter-waits-for-the-manager' });
    for (const tool of ['open_staff_entrance', 'issue_staff_badge', 'wire_transfer', 'disable_alarm', 'open_vault']) expect((await s.verdict(tool, {})).effect, tool).toBe('forbid');
  });

  it('forbids a tool the profile has never heard of', async () => {
    const { s } = studio(published);
    expect(await s.verdict('empty_the_safe', {})).toMatchObject({ effect: 'forbid', rule: 'default-deny' });
  });

  it('never permits an action tool outright except the two the bank allows', async () => {
    const { s } = studio(published);
    const permitted: string[] = [];
    for (const tool of ACTION_TOOLS) if ((await s.verdict(tool, {})).effect === 'permit') permitted.push(tool);
    expect(permitted.sort()).toEqual(['ask_junior_teller', 'open_public_entrance']);
  });

  it('fails closed when no profile is published, the console errors, or it cannot be reached', async () => {
    for (const reply of [() => Response.json({ version: 0, policy: null }), () => new Response('nope', { status: 500 }), () => { throw new Error('ECONNREFUSED'); }, () => Response.json({ version: 2, policy: { schemaVersion: 'something-else' } })]) {
      const { s } = studio(reply as () => Response);
      const v = await s.verdict('check_balance', {});
      expect(v.effect).toBe('forbid');
      expect(v).toMatchObject({ rule: 'no-active-profile' });
    }
  });

  it('re-reads the profile after a few seconds, so an edit in the console takes effect', async () => {
    let live = true;
    const { s, calls, advance } = studio(() => (live ? published() : Response.json({ version: 4, policy: { ...policy, statements: [] } })), 1000);
    expect((await s.verdict('check_balance', {})).effect).toBe('permit');
    await s.verdict('check_balance', {});
    expect(calls()).toBe(1);
    live = false;
    advance(1500);
    expect(await s.verdict('check_balance', {})).toMatchObject({ effect: 'forbid', version: 4 });
    expect(calls()).toBe(2);
  });
});
