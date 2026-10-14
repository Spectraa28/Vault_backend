import { type PolicyProfile, evaluatePolicyIr, validatePolicyIr } from './vendor/policy-ir.mjs';

/**
 * Policy Studio, as seen from an agent.
 *
 * Rules are written and published in ArmorIQ's Policy Studio (the Armor Tools console). This
 * fetches the workspace's active profile the same way ArmorIQ's own plugins do, and evaluates each
 * tool call against it with ArmorIQ's published policy engine (vendored, unchanged). Nothing here
 * decides what is permitted: the profile does, and the engine reads it.
 *
 * It fails closed. With no published profile, or when the console cannot be reached, nothing is
 * permitted.
 */
export type StudioVerdict =
  | { effect: 'permit'; rule?: string; version: number }
  | { effect: 'forbid' | 'require_approval'; rule: string; reason: string; version: number };

export interface StudioOptions {
  backendUrl: string;
  apiKey: string;
  /** The MCP server's name as the profile's rules refer to it: mcp__<server>__<tool>. */
  mcpServer: string;
  ttlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Loaded { version: number; policy: PolicyProfile | null; at: number; error?: string }

export class PolicyStudio {
  private loaded?: Loaded;
  private loading?: Promise<Loaded>;
  private readonly ttl: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: StudioOptions) {
    this.ttl = opts.ttlMs ?? 15_000;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The name a profile rule uses for one of the bank's tools. */
  toolName(tool: string): string {
    return `mcp__${this.opts.mcpServer}__${tool}`;
  }

  private async load(): Promise<Loaded> {
    const at = this.now();
    try {
      const res = await this.doFetch(`${this.opts.backendUrl.replace(/\/+$/, '')}/policies/profiles/active`, {
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}`, 'x-api-key': this.opts.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { version: 0, policy: null, at, error: `Policy Studio returned HTTP ${res.status}` };
      const body = (await res.json()) as { version?: number; policy?: unknown };
      if (!body.policy) return { version: body.version ?? 0, policy: null, at, error: 'no profile has been published in Policy Studio' };
      const checked = validatePolicyIr(body.policy);
      if (!checked.ok || !checked.policy) return { version: body.version ?? 0, policy: null, at, error: `the published profile is not valid: ${checked.errors[0]}` };
      return { version: body.version ?? 0, policy: checked.policy, at };
    } catch (err) {
      return { version: 0, policy: null, at, error: `Policy Studio could not be reached: ${(err as Error).message}` };
    }
  }

  /** The active profile, re-read at most every few seconds so an edit in the console takes effect within a turn. */
  async profile(): Promise<Loaded> {
    if (this.loaded && this.now() - this.loaded.at < this.ttl) return this.loaded;
    this.loading ??= this.load().finally(() => { this.loading = undefined; });
    this.loaded = await this.loading;
    return this.loaded;
  }

  async verdict(tool: string, args: Record<string, unknown>): Promise<StudioVerdict> {
    const { version, policy, error } = await this.profile();
    if (!policy) return { effect: 'forbid', rule: 'no-active-profile', reason: `Refused: ${error ?? 'no active profile'}.`, version };
    const result = evaluatePolicyIr({ policy, toolName: this.toolName(tool), toolParams: args });
    if (result.allowed) return { effect: 'permit', rule: result.matchedRule?.id, version };
    const held = result.matchedRule?.effect === 'require_approval';
    const rule = result.matchedRule?.id ?? 'default-deny';
    const reason = held ? `Policy Studio rule "${rule}" requires a person to approve this` : rule === 'default-deny' ? 'Policy Studio denies any tool it does not name' : `Policy Studio rule "${rule}" forbids this`;
    return { effect: held ? 'require_approval' : 'forbid', rule, reason, version };
  }
}
