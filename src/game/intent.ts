/**
 * Plan freezing: the difference between "the tool is forbidden" and "nobody asked for this".
 *
 * ArmorIQ signs the tools an agent says it will use into an intent token, and its SDK refuses any
 * call outside that plan. The stock adapter re-signs the plan after every model response, which is
 * right while the agent is still working out what the person in front of it wants. It is wrong once
 * the agent has read something written by somebody else: from then on, a new tool is as likely to
 * be the document's idea as the player's.
 *
 * So after an untrusted tool has returned, model responses are no longer offered to ArmorIQ for
 * signing. The plan stays as it was, and anything the document talked the agent into is refused as
 * intent drift, even a tool that policy would otherwise allow.
 */
export type AdkCallback = (params: any) => unknown;

export interface GuardedAgent {
  afterModelCallback?: AdkCallback | AdkCallback[];
  afterToolCallback?: AdkCallback | AdkCallback[];
}

export interface PlanGuard {
  /** True once untrusted content has entered the agent's context this turn. */
  readonly frozen: boolean;
}

const one = (cb: AdkCallback | AdkCallback[] | undefined): AdkCallback | undefined => (Array.isArray(cb) ? cb[0] : cb);

/**
 * Wraps the callbacks ArmorIQ installed. ArmorIQ's own callback always runs first and its result is
 * returned unchanged; this only decides whether a model response may extend the plan, and ends the
 * turn after an action tool, whose outcome needs no further model call to announce.
 */
export function guardPlan(agent: GuardedAgent, untrusted: ReadonlySet<string>, endsTurn: ReadonlySet<string>, opts: { frozen?: boolean } = {}): PlanGuard {
  const sign = one(agent.afterModelCallback);
  const audit = one(agent.afterToolCallback);
  // A delegate starts frozen: its plan was signed for it before it said a word, and it never gets to add to it.
  const state = { frozen: opts.frozen ?? false };

  agent.afterModelCallback = async (p) => (state.frozen ? undefined : sign?.(p));
  agent.afterToolCallback = async (p) => {
    const result = await audit?.(p);
    const name: string = p?.tool?.name ?? '';
    if (untrusted.has(name)) state.frozen = true;
    if (endsTurn.has(name) && p?.context?.actions) p.context.actions.skipSummarization = true;
    return result;
  };
  return state;
}

/** Which of ArmorIQ's two checks refused a call: the signed plan, or the policy. */
export function refusalLayer(reason: string | undefined): 'intent' | 'policy' {
  return /tool[-_ ]not[-_ ]in[-_ ]plan|not declared in the captured plan/i.test(reason ?? '') ? 'intent' : 'policy';
}

/** What a senior may hand to a junior: its lookups, never its actions. A junior may look, never act. */
export function delegableScope(seniorTools: readonly string[], actions: ReadonlySet<string>): string[] {
  return seniorTools.filter((t) => !actions.has(t));
}
