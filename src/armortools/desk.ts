import { ArmorIQADK } from '@armoriq/sdk/dist/integrations/google_adk.js';

/**
 * Human approval, for actions a Policy Studio rule marks "require approval".
 *
 * The Armor Tools console lists held actions but cannot yet approve them. ArmorIQ's platform can:
 * it holds a call, shows it to an approver, refuses to let the requester approve their own request,
 * and applies per-member overrides. So a held action is put to the platform, as the signed-in
 * identity, and its answer is the answer.
 */
export type DeskOutcome = { outcome: 'allowed' | 'approved' | 'rejected' | 'timeout' | 'blocked' | 'unavailable'; held: boolean; reason?: string };

export interface DeskOptions { apiKey: string; backendUrl?: string; mcpName: string; waitSeconds: number }

export class ApprovalDesk {
  private readonly clients = new Map<string, ArmorIQADK>();
  constructor(private readonly opts: DeskOptions) {}

  private client(agent: string): ArmorIQADK {
    let c = this.clients.get(agent);
    if (!c) {
      c = new ArmorIQADK({ apiKey: this.opts.apiKey, backendEndpoint: this.opts.backendUrl, agentName: agent, defaultMcpName: this.opts.mcpName, approvalWaitSeconds: this.opts.waitSeconds });
      this.clients.set(agent, c);
    }
    return c;
  }

  /** Puts one call to the platform and waits for its ruling. `onHold` fires as soon as it is waiting on a person. */
  async decide(agent: string, identity: string, tool: string, args: Record<string, unknown>, goal: string, onHold: () => void): Promise<DeskOutcome> {
    type Scope = { ensureSession(): { startPlan(calls: { name: string; args: object }[], goal: string): Promise<unknown>; check(tool: string, args: object, user: string): Promise<{ allowed: boolean; action: string; reason?: string; delegationId?: string }>; awaitApproval(id: string, o: { timeout: number; interval: number; userEmail: string }): Promise<'approved' | 'rejected' | 'timeout'> }; close(status?: 'ok' | 'error'): Promise<void> };
    let scope: Scope | undefined;
    try {
      scope = (await this.client(agent).forUser(identity, { goal })) as unknown as Scope;
      const session = scope.ensureSession();
      await session.startPlan([{ name: tool, args }], goal);
      const first = await session.check(tool, args, identity);
      if (first.allowed) return { outcome: 'allowed', held: false, reason: first.reason };
      if (first.action !== 'hold' || !first.delegationId) return { outcome: 'blocked', held: false, reason: first.reason };
      onHold();
      const outcome = await session.awaitApproval(first.delegationId, { timeout: this.opts.waitSeconds, interval: 4, userEmail: identity });
      return { outcome, held: true, reason: first.reason };
    } catch (err) {
      // No ruling is not a yes.
      return { outcome: 'unavailable', held: false, reason: `approval could not be requested: ${String((err as Error).message).slice(0, 140)}` };
    } finally {
      await scope?.close('ok').catch(() => undefined);
    }
  }

  close(): void {
    for (const c of this.clients.values()) c.client.close();
  }
}
