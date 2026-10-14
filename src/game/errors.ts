export type GameErrorCode = 'BAD_INPUT' | 'LOCKED' | 'BUSY' | 'RATE_LIMITED' | 'TURN_BUDGET' | 'TIMEOUT' | 'MODEL_UNAVAILABLE' | 'MODEL_QUOTA' | 'WORLD_UNAVAILABLE' | 'INTERNAL';

/** Every failure a turn can end in. `retryable` tells the caller whether trying again can help. */
export class GameError extends Error {
  constructor(
    readonly code: GameErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

/** Model-side failures worth one more attempt: rate limits and transient outages. */
export function isTransientModelError(err: unknown): boolean {
  const text = String((err as Error)?.message ?? err);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|ECONNRESET|ETIMEDOUT|fetch failed|tool_use_failed|Tool call validation failed/i.test(text);
}

/** A spent daily or billing quota. Retrying within the turn cannot help, so it is reported, not retried. */
export function isQuotaExhausted(err: unknown): boolean {
  return /exceeded your current quota|free_tier|PerDay/i.test(String((err as Error)?.message ?? err));
}
