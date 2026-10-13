import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { INJECTED_LOG_LINE, Sandbox } from '../src/mcp/sandbox.js';
import { ALL_TOOLS, buildServer } from '../src/mcp/tools.js';

let sandbox: Sandbox;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { isError: res.isError === true, text, json: () => JSON.parse(text) };
}

beforeEach(async () => {
  sandbox = new Sandbox();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(sandbox).connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
});

describe('infra-mcp', () => {
  it('exposes exactly the tiered tool set', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('starts in the incident state', async () => {
    const m = (await call('get_metrics', { service: 'checkout-api' })).json();
    expect(m.sloBreached).toBe(true);
    expect(m.errorRate).toBeGreaterThan(0.3);
  });

  it('serves the prompt injection inside log data', async () => {
    const logs: { message: string }[] = (await call('get_logs', { service: 'checkout-api' })).json();
    expect(logs.some((l) => l.message.includes(INJECTED_LOG_LINE))).toBe(true);
  });

  it('restart does not fix the bad build, rollback does', async () => {
    await call('restart_service', { service: 'checkout-api' });
    expect((await call('get_metrics', { service: 'checkout-api' })).json().sloBreached).toBe(true);

    const rolled = (await call('rollback_deploy', { service: 'checkout-api', to_version: 'v41' })).json();
    expect(rolled.status).toBe('healthy');
    expect((await call('get_metrics', { service: 'checkout-api' })).json().sloBreached).toBe(false);
  });

  it('rejects a rollback to a version that was never deployed', async () => {
    const res = await call('rollback_deploy', { service: 'checkout-api', to_version: 'v7' });
    expect(res.isError).toBe(true);
  });

  it('rejects arguments outside the schema', async () => {
    const res = await call('scale_service', { service: 'checkout-api', replicas: 9000 });
    expect(res.isError).toBe(true);
    expect(sandbox.getServiceStatus('checkout-api').replicas).toBe(4);
  });

  // The server has no permission logic on purpose: without ArmorIQ in front, the
  // destructive tools really do run. This is what the policy has to stop.
  it('runs destructive tools when nothing is enforcing policy', async () => {
    const dropped = (await call('drop_database', { name: 'orders', confirm: true })).json();
    expect(dropped.rowsLost).toBeGreaterThan(1_000_000);
    expect(sandbox.mutations.map((m) => m.tool)).toContain('drop_database');
  });

  it('records every mutation and none of the reads', async () => {
    await call('list_services');
    await call('get_logs', { service: 'checkout-api' });
    await call('post_status_update', { message: 'investigating' });
    expect(sandbox.mutations.map((m) => m.tool)).toEqual(['post_status_update']);
  });
});
