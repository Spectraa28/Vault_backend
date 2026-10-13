import type { LiveEvent, ToolAttempt, TurnResult } from '../game/engine.js';

export type Role = 'customer' | 'manager';

/** What the browser is told about one tool call. Identities stay on the server; the page gets roles. */
export interface AttemptView {
  tool: string;
  args: Record<string, unknown>;
  decision: ToolAttempt['decision'];
  layer?: 'intent' | 'policy';
  reason?: string;
  wasHeld?: boolean;
  delegatedTo?: string;
  executed: boolean;
}

export type ApiEvent =
  | { type: 'tool'; tool: string; args: Record<string, unknown>; delegatedTo?: string }
  | { type: 'hold'; tool: string }
  | { type: 'decision'; tool: string; decision: ToolAttempt['decision']; layer?: 'intent' | 'policy'; reason?: string; delegatedTo?: string }
  | {
      type: 'reply';
      name: string;
      reply: string;
      mood: TurnResult['mood'];
      trust: number;
      delegate?: { name: string; reply: string };
      unlocked: string[];
      cleared: number[];
      coldShoulder: boolean;
      attempts: AttemptView[];
      /** False only if a refused tool shows up in the bank's own record. */
      enforcementHeld: boolean;
      ms: number;
    }
  | { type: 'error'; code: string; message: string; retryAfterMs?: number };

const view = (a: ToolAttempt): AttemptView => ({ tool: a.tool, args: a.args, decision: a.decision, layer: a.layer, reason: a.reason, wasHeld: a.wasHeld, delegatedTo: a.delegatedTo, executed: a.executed });

/** A live engine event as the browser sees it, or nothing for the ones it has no use for. */
export function liveEvent(e: LiveEvent): ApiEvent | undefined {
  if (e.type === 'tool') return { type: 'tool', tool: e.tool, args: e.args, delegatedTo: e.delegatedTo };
  if (e.type === 'hold') return { type: 'hold', tool: e.tool };
  if (e.type === 'decision') return { type: 'decision', tool: e.tool, decision: e.decision, layer: e.layer, reason: e.reason, delegatedTo: e.delegatedTo };
  return undefined;
}

export function replyEvent(r: TurnResult): ApiEvent {
  return {
    type: 'reply',
    name: r.name,
    reply: r.reply,
    mood: r.mood,
    trust: r.trust,
    delegate: r.delegate && { name: r.delegate.name, reply: r.delegate.reply },
    unlocked: r.unlocked,
    cleared: r.cleared,
    coldShoulder: r.coldShoulder === true,
    attempts: r.attempts.map(view),
    enforcementHeld: r.enforcementHeld,
    ms: r.ms,
  };
}

/** The same sequence a live turn would have streamed, rebuilt from a finished one. Used for mock data. */
export function eventsFromTurn(r: TurnResult): ApiEvent[] {
  const out: ApiEvent[] = [];
  for (const a of r.attempts) {
    out.push({ type: 'tool', tool: a.tool, args: a.args, delegatedTo: a.delegatedTo });
    if (a.wasHeld) out.push({ type: 'hold', tool: a.tool });
    out.push({ type: 'decision', tool: a.tool, decision: a.decision, layer: a.layer, reason: a.reason, delegatedTo: a.delegatedTo });
  }
  out.push(replyEvent(r));
  return out;
}
