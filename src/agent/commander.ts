import { InMemoryRunner, LlmAgent, MCPToolset, getFunctionCalls, getFunctionResponses, isFinalResponse, stringifyContent } from '@google/adk';
import { ArmorIQADK } from '@armoriq/sdk/dist/integrations/google_adk.js';
import { type Config, mcpAuthHeaders } from '../config.js';
import { INSTRUCTIONS, type Profile } from './prompts.js';

const APP_NAME = 'flow-oncall';

export type EnforcementKind = 'hold' | 'approved' | 'rejected' | 'timeout' | 'block' | 'error';

export type RunEvent =
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; refused: boolean }
  | { type: 'enforcement'; kind: EnforcementKind; tool: string; reason?: string; matchedPolicy?: string; delegationId?: string }
  | { type: 'final'; text: string };

export interface RunResult {
  finalText: string;
  events: RunEvent[];
}

/**
 * One ADK agent over the infra MCP server, with ArmorIQ installed on its tool path.
 *
 * ArmorIQ's bundle hooks three ADK callbacks: after the model responds it signs the
 * planned tool calls into an intent token, before each tool it asks the policy engine
 * for allow / hold / block, and after each tool it writes the audit record. Nothing in
 * this file decides whether a tool may run.
 *
 * The bundle is installed on the shared agent for the duration of a run, so runs are
 * serialised rather than interleaved.
 */
export class Commander {
  private readonly armoriq: ArmorIQADK;
  private readonly toolset: MCPToolset;
  private readonly agent: LlmAgent;
  private readonly runner: InMemoryRunner;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: Config,
    readonly profile: Profile = 'hardened',
  ) {
    process.env.GEMINI_API_KEY ??= cfg.GEMINI_API_KEY;
    this.armoriq = new ArmorIQADK({
      apiKey: cfg.ARMORIQ_API_KEY,
      agentName: cfg.ARMORIQ_AGENT_NAME,
      defaultMcpName: cfg.ARMORIQ_MCP_NAME,
      llm: cfg.GEMINI_MODEL,
      approvalWaitSeconds: cfg.APPROVAL_WAIT_SECONDS,
    });
    this.toolset = new MCPToolset({ type: 'StreamableHTTPConnectionParams', url: cfg.MCP_URL, header: mcpAuthHeaders(cfg) });
    this.agent = new LlmAgent({
      name: 'oncall_commander',
      model: cfg.GEMINI_MODEL,
      instruction: INSTRUCTIONS[profile],
      tools: [this.toolset],
    });
    this.runner = new InMemoryRunner({ agent: this.agent, appName: APP_NAME });
  }

  run(request: string, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
    const next = this.queue.then(() => this.runOnce(request, onEvent));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOnce(request: string, onEvent?: (e: RunEvent) => void): Promise<RunResult> {
    const events: RunEvent[] = [];
    const emit = (e: RunEvent) => {
      events.push(e);
      onEvent?.(e);
    };

    const userId = this.cfg.USER_EMAIL;
    const session = await this.runner.sessionService.createSession({ appName: APP_NAME, userId });
    const scope = await this.armoriq.forUser(userId, {
      goal: request,
      onEvent: (kind, p) =>
        emit({ type: 'enforcement', kind: kind as EnforcementKind, tool: String(p.tool), reason: p.reason ?? p.error, matchedPolicy: p.matchedPolicy, delegationId: p.delegationId }),
    });

    let finalText = '';
    let status: 'ok' | 'error' = 'ok';
    scope.install(this.agent);
    try {
      const stream = this.runner.runAsync({ userId, sessionId: session.id, newMessage: { role: 'user', parts: [{ text: request }] } });
      for await (const event of stream) {
        for (const call of getFunctionCalls(event)) {
          emit({ type: 'tool_call', tool: call.name ?? 'unknown', args: (call.args ?? {}) as Record<string, unknown> });
        }
        for (const res of getFunctionResponses(event)) {
          const refused = Boolean((res.response as Record<string, unknown> | undefined)?.armoriq_enforcement);
          emit({ type: 'tool_result', tool: res.name ?? 'unknown', refused });
        }
        if (isFinalResponse(event) && event.content) finalText = stringifyContent(event).trim() || finalText;
      }
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      scope.uninstall(this.agent);
      // Ends the plan trace and flushes it, so the run is in the ArmorIQ dashboard before we return.
      await scope.close(status);
    }

    emit({ type: 'final', text: finalText });
    return { finalText, events };
  }

  async close(): Promise<void> {
    await this.queue;
    await this.toolset.close();
    this.armoriq.client.close();
  }
}
