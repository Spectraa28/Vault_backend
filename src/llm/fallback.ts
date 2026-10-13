import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';

const GIVE_UP_ON = /^(408|429|5\d\d)$/;

/**
 * Tries each model in order and moves on when one is rate-limited, out of quota or down.
 *
 * It only falls through if the failing model produced nothing. The conversation history ADK
 * passes in is provider-neutral, so the next model picks up mid-conversation with full memory.
 */
export class FallbackLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [];
  /** Which model answered most recently. Surfaced in logs and the ArmorIQ trace. */
  lastUsed: string;

  constructor(private readonly chain: BaseLlm[]) {
    if (!chain.length) throw new Error('FallbackLlm needs at least one model');
    super({ model: chain[0]!.model });
    this.lastUsed = chain[0]!.model;
  }

  async *generateContentAsync(req: LlmRequest, stream?: boolean, abortSignal?: AbortSignal): AsyncGenerator<LlmResponse, void> {
    let lastError: LlmResponse | undefined;
    for (const [i, llm] of this.chain.entries()) {
      const isLast = i === this.chain.length - 1;
      let produced = false;
      let failed: LlmResponse | undefined;
      try {
        for await (const res of llm.generateContentAsync(req, stream, abortSignal)) {
          if (res.errorCode && !produced && !isLast && GIVE_UP_ON.test(res.errorCode)) {
            failed = res;
            break;
          }
          produced = true;
          this.lastUsed = llm.model;
          yield res;
        }
      } catch (err) {
        if (produced || isLast) throw err;
        failed = { errorCode: '503', errorMessage: (err as Error).message };
      }
      if (!failed) return;
      lastError = failed;
      console.warn(`[llm] ${llm.model} unavailable (${failed.errorCode}), falling back`);
    }
    if (lastError) yield lastError;
  }

  connect(req: LlmRequest): Promise<BaseLlmConnection> {
    return this.chain[0]!.connect(req);
  }
}
