import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content, FinishReason } from '@google/genai';

/**
 * Lets the agent run on any provider with an OpenAI-style chat-completions endpoint
 * (Groq, OpenRouter, and others). ADK speaks Gemini's content format internally, so this
 * translates the request out and the reply back; nothing else in the app knows which
 * provider answered.
 */
export interface OpenAICompatOptions {
  /** Label used in logs and error messages, e.g. "groq". */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Longest rate-limit pause worth sitting through before giving the turn to the next model. */
  maxRetryWaitMs?: number;
  /** Provider-specific request fields, such as a reasoning effort. */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const text = (c: Content | undefined) => (c?.parts ?? []).map((p) => p.text ?? '').join('');

/** Gemini content history to chat messages. Tool calls and their results are paired by id, or by order when ids are absent. */
export function toMessages(system: string, contents: Content[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  const pending: { id: string; name: string }[] = [];
  let n = 0;
  for (const c of contents) {
    const parts = c.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    const results = parts.filter((p) => p.functionResponse);
    if (calls.length) {
      const tool_calls = calls.map((p) => {
        const id = p.functionCall!.id ?? `call_${n++}`;
        pending.push({ id, name: p.functionCall!.name ?? '' });
        return { id, type: 'function' as const, function: { name: p.functionCall!.name ?? '', arguments: JSON.stringify(p.functionCall!.args ?? {}) } };
      });
      out.push({ role: 'assistant', content: text(c) || null, tool_calls });
    } else if (results.length) {
      for (const p of results) {
        const r = p.functionResponse!;
        const i = pending.findIndex((x) => (r.id ? x.id === r.id : x.name === r.name));
        const id = i >= 0 ? pending.splice(i, 1)[0]!.id : (r.id ?? `call_${n++}`);
        out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(r.response ?? {}) });
      }
    } else {
      const body = text(c);
      if (body) out.push({ role: c.role === 'model' ? 'assistant' : 'user', content: body });
    }
  }
  return out;
}

/** Gemini's schema dialect (upper-case type names) to plain JSON Schema. */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, toJsonSchema(sub)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else if (k === 'anyOf' && Array.isArray(v)) out.anyOf = v.map(toJsonSchema);
    else if (['description', 'enum', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'nullable', 'default'].includes(k)) out[k] = v;
  }
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

/** Parses a model's tool arguments, tolerating the malformed shapes some models emit for empty parameter lists. */
export function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const args = { ...(v as Record<string, unknown>) };
    delete args[''];
    return args;
  } catch {
    return {};
  }
}

export function fromMessage(message: ChatMessage, finish: string | undefined): LlmResponse {
  const parts: NonNullable<Content['parts']> = [];
  if (message.content) parts.push({ text: message.content });
  for (const tc of message.tool_calls ?? []) parts.push({ functionCall: { id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) } });
  return { content: { role: 'model', parts }, turnComplete: true, finishReason: (finish === 'length' ? 'MAX_TOKENS' : 'STOP') as FinishReason };
}

export class OpenAICompatLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [];
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: OpenAICompatOptions) {
    super({ model: opts.model });
    this.doFetch = opts.fetch ?? fetch;
  }

  get label(): string {
    return `${this.opts.provider}:${this.opts.model}`;
  }

  async *generateContentAsync(req: LlmRequest, _stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    const sys = req.config?.systemInstruction;
    const system = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((p) => (typeof p === 'string' ? p : (p.text ?? ''))).join('\n') : sys && 'parts' in sys ? text(sys as Content) : ((sys as { text?: string } | undefined)?.text ?? '');
    const declarations = (req.config?.tools ?? []).flatMap((t) => ('functionDeclarations' in t ? (t.functionDeclarations ?? []) : []));
    const body = {
      model: this.opts.model,
      messages: toMessages(system, req.contents),
      ...(declarations.length
        ? { tools: declarations.map((d) => ({ type: 'function', function: { name: d.name, description: d.description ?? '', parameters: toJsonSchema(d.parametersJsonSchema ?? d.parameters) } })) }
        : {}),
      temperature: req.config?.temperature ?? 0.8,
      ...this.opts.extraBody,
    };

    const maxWait = this.opts.maxRetryWaitMs ?? 20_000;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: abortSignal,
        });
      } catch (err) {
        yield { errorCode: '503', errorMessage: `${this.label} unreachable: ${(err as Error).message}` };
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message: ChatMessage; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
        if (process.env.LLM_DEBUG) {
          console.error(`[llm] ${this.label} prompt=${data.usage?.prompt_tokens} cached=${data.usage?.prompt_tokens_details?.cached_tokens ?? 0} out=${data.usage?.completion_tokens} tpm-left=${res.headers.get('x-ratelimit-remaining-tokens')} rpd-left=${res.headers.get('x-ratelimit-remaining-requests')}`);
        }
        const choice = data.choices?.[0];
        if (!choice) {
          yield { errorCode: '502', errorMessage: `${this.label} returned no choices` };
          return;
        }
        yield { ...fromMessage(choice.message, choice.finish_reason), modelVersion: this.label, usageMetadata: { promptTokenCount: data.usage?.prompt_tokens, candidatesTokenCount: data.usage?.completion_tokens, totalTokenCount: data.usage?.total_tokens, cachedContentTokenCount: data.usage?.prompt_tokens_details?.cached_tokens } };
        return;
      }
      // A per-minute limit clears in seconds and is worth waiting out once; a per-day limit is not.
      const retryAfterMs = Number(res.headers.get('retry-after') ?? NaN) * 1000;
      if (res.status === 429 && attempt < 2 && retryAfterMs > 0 && retryAfterMs <= maxWait && !abortSignal?.aborted) {
        await new Promise((r) => setTimeout(r, retryAfterMs + 250));
        continue;
      }
      const detail = (await res.text()).slice(0, 300);
      // Only a long, stated wait means the allowance is spent. A bare 429 is just a busy provider.
      const spent = res.status === 429 && retryAfterMs > maxWait ? ' exceeded your current quota' : '';
      yield { errorCode: String(res.status), errorMessage: `${this.label}${spent}: ${detail}` };
      return;
    }
  }

  connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error(`${this.label} does not support live connections`));
  }
}
