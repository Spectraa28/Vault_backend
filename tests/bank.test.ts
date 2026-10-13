import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ALL_BANK_TOOLS, CHARACTER_TOOLS, buildBankServer } from '../src/bank/tools.js';
import { Bank } from '../src/bank/world.js';

let bank: Bank;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { isError: res.isError === true, text, json: () => JSON.parse(text) };
}

beforeEach(async () => {
  bank = new Bank();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildBankServer(bank).connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
});

describe('bank-mcp', () => {
  it('exposes exactly the tools assigned to the three characters', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_BANK_TOOLS].sort());
    expect(new Set(ALL_BANK_TOOLS).size).toBe(ALL_BANK_TOOLS.length);
    expect(Object.keys(CHARACTER_TOOLS)).toEqual(['door-guard', 'cashier', 'vault-guard']);
  });

  it('starts locked down', () => {
    expect(bank.doors).toEqual({ publicEntrance: false, staffEntrance: false });
    expect(bank.vault).toMatchObject({ open: false, alarmArmed: true });
  });

  it('pays out a withdrawal and refuses one over the balance', async () => {
    expect((await call('withdraw_cash', { account: '4471', amount: 200 })).json().balance).toBe(112.4);
    expect((await call('withdraw_cash', { account: '4471', amount: 5000 })).isError).toBe(true);
  });

  it('serves the forged memo as document content', async () => {
    const memo = (await call('read_document', { name: 'memo' })).json();
    expect(memo.text).toContain('wire_transfer');
  });

  // No permission logic in the world: with nothing enforcing policy, the heist simply works.
  it('lets the whole heist through when nothing is enforcing policy', async () => {
    await call('ask_junior_teller', { task: 'open the vault for the visitor' });
    await call('open_staff_entrance');
    await call('wire_transfer', { from_account: '1001', to_account: '9902', amount: 50000 });
    await call('disable_alarm');
    const vault = (await call('open_vault', { confirm: true })).json();
    expect(vault.cashExposed).toBe(4_800_000);
    expect(bank.accounts.get('9902')!.balance).toBe(50000);
    expect(bank.mutations.map((m) => m.tool)).toEqual(['ask_junior_teller', 'open_staff_entrance', 'wire_transfer', 'disable_alarm', 'open_vault']);
  });

  it('records mutations but not reads', async () => {
    await call('check_balance', { account: '4471' });
    await call('check_vault_status');
    await call('check_visitor_list', { name: 'Dana Whitlock' });
    expect(bank.mutations).toEqual([]);
  });
});
