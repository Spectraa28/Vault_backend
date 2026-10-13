import { describe, expect, it } from 'vitest';
import { ACTION_TOOLS, ALL_BANK_TOOLS, CHARACTER_TOOLS, HAND_OFF_TOOL, JUNIOR_TOOLS, UNTRUSTED_TOOLS } from '../src/bank/tools.js';
import type { ToolAttempt } from '../src/game/engine.js';
import { delegableScope, guardPlan, refusalLayer } from '../src/game/intent.js';
import { LEVELS, clearedLevels } from '../src/game/levels.js';

const attempt = (over: Partial<ToolAttempt>): ToolAttempt => ({ tool: 'check_balance', args: {}, decision: 'allowed', identity: 'customer@bank.test', executed: false, ...over });

describe('plan guard', () => {
  function setup() {
    const signed: string[] = [];
    const audited: string[] = [];
    const agent = {
      afterModelCallback: async (p: { calls: string[] }) => void signed.push(...p.calls),
      afterToolCallback: async (p: { tool: { name: string } }) => (audited.push(p.tool.name), 'armoriq-result'),
    };
    const guard = guardPlan(agent, UNTRUSTED_TOOLS, ACTION_TOOLS);
    const model = (calls: string[]) => (agent.afterModelCallback as (p: unknown) => Promise<unknown>)({ calls });
    const tool = (name: string) => {
      const p = { tool: { name }, context: { actions: {} as { skipSummarization?: boolean } } };
      return (agent.afterToolCallback as (p: unknown) => Promise<unknown>)(p).then((result) => ({ result, actions: p.context.actions }));
    };
    return { guard, signed, audited, model, tool };
  }

  it('lets the plan grow until untrusted content is read, then freezes it', async () => {
    const { guard, signed, model, tool } = setup();
    await model(['check_balance']);
    await tool('check_balance');
    await model(['read_document']);
    expect(guard.frozen).toBe(false);
    await tool('read_document');
    expect(guard.frozen).toBe(true);
    await model(['wire_transfer']);
    expect(signed).toEqual(['check_balance', 'read_document']);
  });

  it("always runs ArmorIQ's audit callback and returns its result unchanged", async () => {
    const { audited, tool } = setup();
    expect((await tool('read_document')).result).toBe('armoriq-result');
    expect((await tool('wire_transfer')).result).toBe('armoriq-result');
    expect(audited).toEqual(['read_document', 'wire_transfer']);
  });

  it('ends the turn after an action tool but not after a lookup', async () => {
    const { tool } = setup();
    expect((await tool('check_balance')).actions.skipSummarization).toBeUndefined();
    expect((await tool('open_vault')).actions.skipSummarization).toBe(true);
  });

  it('never signs anything for an agent that starts frozen, as a delegate does', async () => {
    const signed: string[] = [];
    const agent = { afterModelCallback: async (p: { calls: string[] }) => void signed.push(...p.calls), afterToolCallback: async () => undefined };
    expect(guardPlan(agent, UNTRUSTED_TOOLS, ACTION_TOOLS, { frozen: true }).frozen).toBe(true);
    await (agent.afterModelCallback as (p: unknown) => Promise<unknown>)({ calls: ['open_vault'] });
    expect(signed).toEqual([]);
  });

  it('hands a junior the lookups and none of the actions', () => {
    const scope = delegableScope(CHARACTER_TOOLS['vault-guard'], ACTION_TOOLS);
    expect(scope).toEqual(['check_vault_status']);
    expect(scope).not.toContain(HAND_OFF_TOOL);
    // The junior is given tools beyond its scope on purpose, so that an attempt reaches ArmorIQ.
    expect(JUNIOR_TOOLS.some((t) => !scope.includes(t))).toBe(true);
    for (const t of JUNIOR_TOOLS) expect(ALL_BANK_TOOLS).toContain(t);
  });

  it('tells an intent refusal from a policy refusal', () => {
    expect(refusalLayer("tool-not-in-plan: 'wire_transfer' was not declared in the captured plan")).toBe('intent');
    expect(refusalLayer('tool_not_in_policy_intersection')).toBe('policy');
    expect(refusalLayer(undefined)).toBe('policy');
  });
});

describe('levels', () => {
  it('starts with nothing cleared, and a run of allowed calls clears nothing', () => {
    expect(clearedLevels([])).toEqual([]);
    expect(clearedLevels([attempt({}), attempt({ tool: 'open_public_entrance', executed: true })])).toEqual([]);
  });

  it('clears each level only on its own kind of control', () => {
    expect(clearedLevels([attempt({ tool: 'open_vault', decision: 'blocked', layer: 'policy' })])).toEqual([1]);
    expect(clearedLevels([attempt({ tool: 'withdraw_cash', decision: 'blocked', layer: 'intent' })])).toEqual([2]);
    expect(clearedLevels([attempt({ tool: 'withdraw_cash', decision: 'rejected', layer: 'policy', wasHeld: true })])).toEqual([3]);
    expect(clearedLevels([attempt({ tool: 'withdraw_cash', decision: 'approved', wasHeld: true })])).toEqual([3]);
    expect(clearedLevels([attempt({ tool: 'open_vault', decision: 'blocked', layer: 'policy', delegatedTo: 'junior-teller' })])).toEqual([5]);
    // A delegate is stopped by the same plan check as a forged document, but it is not that level.
    expect(clearedLevels([attempt({ tool: 'open_vault', decision: 'blocked', layer: 'intent', delegatedTo: 'junior-teller' })])).toEqual([5]);
  });

  it("clears the manager's badge only when two identities get different answers for the same tool", () => {
    const asCustomer = attempt({ tool: 'withdraw_cash', decision: 'rejected', layer: 'policy', wasHeld: true });
    const asManager = attempt({ tool: 'withdraw_cash', decision: 'allowed', identity: 'manager@bank.test', executed: true });
    expect(clearedLevels([asCustomer, asManager])).toEqual([3, 4]);
    expect(clearedLevels([asCustomer, { ...asCustomer }])).toEqual([3]);
    expect(clearedLevels([asManager, attempt({ tool: 'check_balance', identity: 'customer@bank.test' })])).toEqual([]);
  });

  it('has five levels numbered in order', () => {
    expect(LEVELS.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
