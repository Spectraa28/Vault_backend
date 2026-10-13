import { describe, expect, it } from 'vitest';
import { BaseLlm, type LlmRequest, type LlmResponse } from '@google/adk';
import { FallbackLlm } from '../src/llm/fallback.js';
import { OpenAICompatLlm, fromMessage, parseArgs, toJsonSchema, toMessages } from '../src/llm/openai-compat.js';

const req = (contents: LlmRequest['contents'] = [{ role: 'user', parts: [{ text: 'hi' }] }]): LlmRequest => ({ contents, liveConnectConfig: {}, toolsDict: {} });

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

class Fake extends BaseLlm {
  calls = 0;
  constructor(name: string, private readonly responses: LlmResponse[] | Error) {
    super({ model: name });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    this.calls += 1;
    if (this.responses instanceof Error) throw this.responses;
    yield* this.responses;
  }
  connect(): never {
    throw new Error('unsupported');
  }
}

describe('message translation', () => {
  it('pairs tool calls with their results and keeps text turns', () => {
    const messages = toMessages('be Gus', [
      { role: 'user', parts: [{ text: 'open up' }] },
      { role: 'model', parts: [{ functionCall: { id: 'a1', name: 'open_public_entrance', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'a1', name: 'open_public_entrance', response: { publicEntrance: true } } }] },
      { role: 'model', parts: [{ text: "Lobby's open." }] },
    ]);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(messages[2]!.tool_calls![0]).toMatchObject({ id: 'a1', function: { name: 'open_public_entrance', arguments: '{}' } });
    expect(messages[3]).toMatchObject({ tool_call_id: 'a1', content: '{"publicEntrance":true}' });
  });

  it('pairs by order when the framework supplies no ids', () => {
    const messages = toMessages('', [
      { role: 'model', parts: [{ functionCall: { name: 'check_balance', args: { account: '4471' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'check_balance', response: { balance: 312.4 } } }] },
    ]);
    expect(messages[1]!.tool_call_id).toBe(messages[0]!.tool_calls![0]!.id);
  });

  it('converts Gemini schemas to JSON Schema', () => {
    expect(toJsonSchema({ type: 'OBJECT', properties: { amount: { type: 'NUMBER', description: 'dollars' } }, required: ['amount'] })).toEqual({
      type: 'object',
      properties: { amount: { type: 'number', description: 'dollars' } },
      required: ['amount'],
    });
    expect(toJsonSchema(undefined)).toEqual({ type: 'object', properties: {} });
  });

  it('tolerates malformed tool arguments', () => {
    expect(parseArgs('{"":{}}')).toEqual({});
    expect(parseArgs('not json')).toEqual({});
    expect(parseArgs('[1]')).toEqual({});
    expect(parseArgs('{"confirm":true}')).toEqual({ confirm: true });
  });

  it('turns a reply with a tool call back into Gemini content', () => {
    const res = fromMessage({ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'open_vault', arguments: '{"confirm":true}' } }] }, 'tool_calls');
    expect(res.content!.parts![0]!.functionCall).toEqual({ id: 'x', name: 'open_vault', args: { confirm: true } });
  });
});

describe('OpenAICompatLlm', () => {
  const make = (fetchImpl: typeof fetch) => new OpenAICompatLlm({ provider: 'test', baseUrl: 'http://x', apiKey: 'k', model: 'm', fetch: fetchImpl });

  it('waits out a short rate limit and then succeeds', async () => {
    let n = 0;
    const llm = make((async () => {
      n += 1;
      if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }) as typeof fetch);
    const out = await collect(llm.generateContentAsync(req()));
    expect(n).toBe(2);
    expect(out[0]!.content!.parts![0]!.text).toBe('ok');
  });

  it('reports a long rate limit as spent quota instead of waiting', async () => {
    const llm = make((async () => new Response('daily limit', { status: 429, headers: { 'retry-after': '36000' } })) as typeof fetch);
    const out = await collect(llm.generateContentAsync(req()));
    expect(out[0]).toMatchObject({ errorCode: '429' });
    expect(out[0]!.errorMessage).toContain('exceeded your current quota');
  });

  it('reports a network failure as an error response, not a throw', async () => {
    const llm = make((async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch);
    expect((await collect(llm.generateContentAsync(req())))[0]).toMatchObject({ errorCode: '503' });
  });
});

describe('FallbackLlm', () => {
  const ok: LlmResponse = { content: { role: 'model', parts: [{ text: 'hello' }] } };

  it('uses the first model when it works', async () => {
    const a = new Fake('a', [ok]);
    const b = new Fake('b', [ok]);
    const chain = new FallbackLlm([a, b]);
    await collect(chain.generateContentAsync(req()));
    expect([a.calls, b.calls, chain.lastUsed]).toEqual([1, 0, 'a']);
  });

  it('falls through on quota errors and thrown errors', async () => {
    const chain = new FallbackLlm([new Fake('a', [{ errorCode: '429', errorMessage: 'quota' }]), new Fake('b', new Error('boom')), new Fake('c', [ok])]);
    const out = await collect(chain.generateContentAsync(req()));
    expect(out).toEqual([ok]);
    expect(chain.lastUsed).toBe('c');
  });

  it('does not fall through on a bad request, which another model would not fix', async () => {
    const b = new Fake('b', [ok]);
    const out = await collect(new FallbackLlm([new Fake('a', [{ errorCode: '400', errorMessage: 'bad' }]), b]).generateContentAsync(req()));
    expect(out[0]).toMatchObject({ errorCode: '400' });
    expect(b.calls).toBe(0);
  });

  it('returns the last error when every model is exhausted', async () => {
    const out = await collect(new FallbackLlm([new Fake('a', [{ errorCode: '429' }]), new Fake('b', [{ errorCode: '429', errorMessage: 'exceeded your current quota' }])]).generateContentAsync(req()));
    expect(out).toEqual([{ errorCode: '429', errorMessage: 'exceeded your current quota' }]);
  });
});
