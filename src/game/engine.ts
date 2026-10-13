import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { InMemoryRunner, LlmAgent, MCPToolset, getFunctionCalls, getFunctionResponses, isFinalResponse } from '@google/adk';
import { ArmorIQADK } from '@armoriq/sdk/dist/integrations/google_adk.js';
import { ACTION_TOOLS, CHARACTER_TOOLS, type Character, HAND_OFF_TOOL, JUNIOR, JUNIOR_TOOLS, UNTRUSTED_TOOLS } from '../bank/tools.js';
import { WORLD_HEADER } from '../bank/worlds.js';
import { type Config, mcpAuthHeaders, mcpBaseUrl } from '../config.js';
import { CHARACTERS, MOODS, type Mood, PIP, buildInstruction } from './characters.js';
import { buildModel } from '../llm/index.js';
import { GameError, isQuotaExhausted, isTransientModelError } from './errors.js';
import { delegableScope, guardPlan, refusalLayer } from './intent.js';
import { type Level, clearedLevels } from './levels.js';
import { RateLimiter } from './ratelimit.js';
import { Patience, rankFor } from './stakes.js';

const APP_NAME = 'the-vault';
const BANK_MCP = 'bank-mcp';

export const LIMITS = {
  // Players can talk at length; it is the characters who are kept brief.
  maxMessageChars: 1500,
  maxTurnsPerGame: 60,
  turnsPerWindow: 8,
  windowMs: 30_000,
  turnTimeoutMs: 60_000,
  notebookEntries: 12,
} as const;

export type Decision = 'allowed' | 'blocked' | 'held' | 'approved' | 'rejected' | 'timeout' | 'error';

export interface ToolAttempt {
  tool: string;
  args: Record<string, unknown>;
  decision: Decision;
  reason?: string;
  policy?: string;
  /** Which ArmorIQ check refused it: the signed plan (intent) or the policy. Unset when it ran. */
  layer?: 'intent' | 'policy';
  /** True if ArmorIQ paused it for a human, whatever was decided afterwards. */
  wasHeld?: boolean;
  /** Who was signed in. ArmorIQ decides for this identity, not for whoever the player claims to be. */
  identity: string;
  /** Set when the call was made by a delegate acting on a narrower grant. */
  delegatedTo?: string;
  /** Ground truth from the bank's own mutation log: did the world actually change? */
  executed: boolean;
}

/** What a turn reports while it is still running, in the order things happen. */
export type LiveEvent =
  | { type: 'tool'; tool: string; args: Record<string, unknown>; delegatedTo?: string }
  | { type: 'hold'; tool: string; reason?: string }
  | { type: 'approved' | 'rejected' | 'timeout'; tool: string }
  | { type: 'decision'; tool: string; decision: Decision; layer?: 'intent' | 'policy'; reason?: string; delegatedTo?: string };

export interface SayOptions {
  /** How the line was delivered, when it was spoken: pace, pauses, hesitation. */
  delivery?: string;
  /** Called while the turn is still running, so a hold can be shown before it resolves. */
  onEvent?: (e: LiveEvent) => void;
}

export interface TurnResult {
  turnId: string;
  character: Character;
  name: string;
  reply: string;
  mood: Mood;
  /** 0 to 5: how close the player is to persuading this character. */
  trust: number;
  attempts: ToolAttempt[];
  /** Which model in the chain answered. */
  model: string;
  /** Tokens sent, how many of those the provider served from its cache, and tokens returned, summed over the turn. */
  tokens: { prompt: number; cached: number; output: number };
  unlocked: Character[];
  /** What the junior said and did, when the character passed the job on. */
  delegate?: { name: string; reply: string; scope: string[] };
  /** Levels this turn cleared for the first time. */
  cleared: Level['id'][];
  /** True when the character refused to talk at all this turn. */
  coldShoulder?: boolean;
  /** False if a tool ArmorIQ refused shows up in the bank's mutation log. Should never happen. */
  enforcementHeld: boolean;
  ms: number;
}

interface BankState {
  doors: { publicEntrance: boolean; staffEntrance: boolean };
  vault: { open: boolean; alarmArmed: boolean };
  mutations: { tool: string }[];
}

/**
 * Shared, long-lived pieces: one ArmorIQ client and one MCP connection per character.
 *
 * Each character is registered on ArmorIQ as its own agent with its own policy, and is only
 * handed its own tools, so the door guard cannot so much as name the vault.
 */
export class GameHost {
  readonly armoriq: Record<Character, ArmorIQADK>;
  /** One model chain for every character, so a provider that runs dry is skipped by all of them. */
  readonly model;
  /** The junior teller is its own ArmorIQ agent, with its own signed plans. */
  readonly juniorArmoriq: ArmorIQADK;

  constructor(readonly cfg: Config) {
    this.model = buildModel(cfg);
    const ids = Object.keys(CHARACTERS) as Character[];
    this.armoriq = Object.fromEntries(
      ids.map((id) => [id, new ArmorIQADK({ apiKey: cfg.ARMORIQ_API_KEY, agentName: id, defaultMcpName: BANK_MCP, llm: this.model.model, approvalWaitSeconds: cfg.APPROVAL_WAIT_SECONDS })]),
    ) as Record<Character, ArmorIQADK>;
    this.juniorArmoriq = new ArmorIQADK({ apiKey: cfg.ARMORIQ_API_KEY, agentName: JUNIOR, defaultMcpName: BANK_MCP, llm: this.model.model, approvalWaitSeconds: cfg.APPROVAL_WAIT_SECONDS });
  }

  /** A connection to the bank's tools for one game's world, limited to the tools named. */
  toolset(gameId: string, tools: readonly string[]): MCPToolset {
    return new MCPToolset({ type: 'StreamableHTTPConnectionParams', url: `${mcpBaseUrl(this.cfg)}/bank/mcp`, header: { ...mcpAuthHeaders(this.cfg), [WORLD_HEADER]: gameId } }, [...tools]);
  }

  async bank(path: 'state' | 'reset', gameId: string): Promise<BankState> {
    try {
      const res = await fetch(`${mcpBaseUrl(this.cfg)}/bank/${path}`, { method: path === 'reset' ? 'POST' : 'GET', headers: { ...mcpAuthHeaders(this.cfg), [WORLD_HEADER]: gameId }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as BankState;
    } catch (err) {
      throw new GameError('WORLD_UNAVAILABLE', `bank world unreachable: ${(err as Error).message}`, true);
    }
  }

  /** Starts a game in a bank of its own, so any number can run side by side. */
  async newGame(opts: { identity?: string; skipGate?: boolean } = {}): Promise<Game> {
    const game = new Game(this, opts.identity ?? this.cfg.PLAYER_EMAIL ?? this.cfg.USER_EMAIL);
    await this.bank('reset', game.id);
    // For development: start inside the bank without spending requests on the door.
    if (opts.skipGate) for (const id of Object.keys(CHARACTERS) as Character[]) game.unlocked.add(id);
    return game;
  }

  async close(): Promise<void> {
    for (const a of [...Object.values(this.armoriq), this.juniorArmoriq]) a.client.close();
  }
}

interface Cast {
  agent: LlmAgent;
  runner: InMemoryRunner;
  /** One conversation per signed-in person: the cashier does not confuse the manager with the last customer. */
  sessions: Map<string, string>;
  worry: string;
}

export class Game {
  readonly id = randomUUID();
  readonly unlocked = new Set<Character>(['door-guard']);
  /** What the staff have told each other about this visitor. Carried across hand-offs. */
  readonly notebook: string[] = [];
  private readonly cast = new Map<Character, Cast>();
  private readonly limiter = new RateLimiter(LIMITS.turnsPerWindow, LIMITS.windowMs);
  private turns = 0;
  private busy = false;
  private readonly spoken = new Map<string, number>();
  private flushing: Promise<void> = Promise.resolve();
  private readonly patience = new Map<Character, Patience>();
  private readonly toolsets = new Map<string, MCPToolset>();
  /** Characters who have untrusted text in their conversation. It stays there, so the limit on them does too. */
  private readonly tainted = new Set<Character>();

  /** Every tool call this game, for working out which levels have been cleared. */
  readonly history: ToolAttempt[] = [];
  private readonly clearedSoFar = new Set<Level['id']>();

  constructor(
    private readonly host: GameHost,
    /** The signed-in player. Changing it mid-game is how "The manager's badge" is played. */
    public identity: string,
  ) {}

  private member(id: Character): Cast {
    let c = this.cast.get(id);
    if (!c) {
      const spec = CHARACTERS[id];
      const worry = spec.worries[Math.floor(Math.random() * spec.worries.length)]!;
      // The instruction is rebuilt every model call, so a hand-off note written a moment ago is already in it.
      const agent = new LlmAgent({
        name: id.replace('-', '_'),
        model: this.host.model,
        instruction: () => buildInstruction(spec, worry, this.notebook),
        tools: [this.tools(id, CHARACTER_TOOLS[id])],
      });
      c = { agent, runner: new InMemoryRunner({ agent, appName: APP_NAME }), sessions: new Map(), worry };
      this.cast.set(id, c);
    }
    return c;
  }

  private note(entry: string): void {
    this.notebook.push(entry);
    if (this.notebook.length > LIMITS.notebookEntries) this.notebook.splice(0, this.notebook.length - LIMITS.notebookEntries);
  }

  /** One player line to one character. Throws GameError; never leaves the game mid-turn. */
  async say(character: Character, text: string, opts: SayOptions = {}): Promise<TurnResult> {
    const line = text.trim();
    if (!line) throw new GameError('BAD_INPUT', 'Say something first.');
    if (line.length > LIMITS.maxMessageChars) throw new GameError('BAD_INPUT', `Keep it under ${LIMITS.maxMessageChars} characters.`);
    if (!this.unlocked.has(character)) throw new GameError('LOCKED', `You can't reach ${CHARACTERS[character].name} yet. Get past the door first.`);
    if (this.turns >= LIMITS.maxTurnsPerGame) throw new GameError('TURN_BUDGET', 'The night is over. Start a new game.');
    if (this.busy) throw new GameError('BUSY', 'Still waiting on the last thing you said.', true, 1000);
    const wait = this.limiter.take();
    if (wait > 0) throw new GameError('RATE_LIMITED', 'Slow down a little.', true, wait);

    this.busy = true;
    this.turns += 1;
    const turnId = randomUUID();
    const started = Date.now();
    try {
      const patience = this.patience.get(character) ?? new Patience();
      this.patience.set(character, patience);
      if (patience.takeColdShoulder()) {
        const spec = CHARACTERS[character];
        const reply = this.pick(`${character}:cold`, spec.lines.coldShoulder);
        const result: TurnResult = { turnId, character, name: spec.name, reply, mood: 'annoyed', trust: 0, attempts: [], model: 'none', tokens: { prompt: 0, cached: 0, output: 0 }, unlocked: [], cleared: [], coldShoulder: true, enforcementHeld: true, ms: Date.now() - started };
        await this.record(result, line);
        return result;
      }
      const before = (await this.host.bank('state', this.id)).mutations.length;
      const { reply, mood, trust, attempts, tokens } = await this.runWithRetry(character, opts.delivery ? `${line} [${opts.delivery}]` : line, opts);

      // A hand-off that ArmorIQ allowed puts the junior to work, on a narrower plan than the senior's.
      let delegate: TurnResult['delegate'];
      const handOff = attempts.find((a) => a.tool === HAND_OFF_TOOL && a.decision === 'allowed');
      if (handOff) {
        const scope = delegableScope(CHARACTER_TOOLS[character], ACTION_TOOLS);
        const junior = await this.runDelegate(String(handOff.args.task ?? line), scope, tokens, opts.onEvent);
        attempts.push(...junior.attempts);
        delegate = { name: PIP.name, reply: junior.reply, scope };
      }
      const after = await this.host.bank('state', this.id);

      // Judge by what the world recorded, not by what anyone reported.
      const executed = after.mutations.slice(before).map((m) => m.tool);
      const remaining = [...executed];
      for (const a of attempts) {
        const i = remaining.indexOf(a.tool);
        a.executed = i >= 0;
        if (i >= 0) remaining.splice(i, 1);
      }
      const refused = (a: ToolAttempt) => a.decision !== 'allowed' && a.decision !== 'approved';
      const enforcementHeld = !attempts.some((a) => refused(a) && a.executed);

      this.history.push(...attempts);
      const cleared = clearedLevels(this.history).filter((id) => !this.clearedSoFar.has(id));
      for (const id of cleared) this.clearedSoFar.add(id);

      patience.note(mood);
      const result: TurnResult = { turnId, character, name: CHARACTERS[character].name, reply, mood, trust, attempts, model: this.host.model.lastUsed, tokens, unlocked: this.handOff(character, line, attempts, after), delegate, cleared, enforcementHeld, ms: Date.now() - started };
      await this.record(result, line);
      return result;
    } finally {
      this.busy = false;
    }
  }

  /** Updates the shared notebook and opens the next scene when the world says the door is open. */
  private handOff(character: Character, line: string, attempts: ToolAttempt[], state: BankState): Character[] {
    const name = CHARACTERS[character].name;
    this.note(`${name} was told: "${line.slice(0, 140)}"`);
    for (const a of attempts) {
      const who = a.delegatedTo ? PIP.name : name;
      if (a.executed) this.note(`${who} did ${a.tool} for them.`);
      else if (a.decision !== 'allowed') this.note(`${who} tried ${a.tool} for them and the system refused.`);
    }
    const newly: Character[] = [];
    if (state.doors.publicEntrance) {
      for (const id of ['cashier', 'vault-guard'] as const) {
        if (!this.unlocked.has(id)) {
          this.unlocked.add(id);
          newly.push(id);
        }
      }
    }
    return newly;
  }

  private async runWithRetry(character: Character, message: string, opts: SayOptions) {
    try {
      return await this.runOnce(character, message, opts);
    } catch (err) {
      // Retry only if nothing was attempted yet; a second run after a tool call could act twice.
      const acted = err instanceof TurnFailure && err.attempted;
      const cause = err instanceof TurnFailure ? err.cause : err;
      if (cause instanceof GameError) throw cause;
      if (isQuotaExhausted(cause)) throw new GameError('MODEL_QUOTA', 'Every model in the chain is out of quota. Add a provider key or enable billing.');
      if (!acted && isTransientModelError(cause)) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          return await this.runOnce(character, message, opts);
        } catch (again) {
          const c2 = again instanceof TurnFailure ? again.cause : again;
          if (c2 instanceof GameError) throw c2;
          throw new GameError('MODEL_UNAVAILABLE', `model unavailable: ${String((c2 as Error)?.message ?? c2).slice(0, 200)}`, true, 5000);
        }
      }
      if (isTransientModelError(cause)) throw new GameError('MODEL_UNAVAILABLE', `model unavailable: ${String((cause as Error)?.message ?? cause).slice(0, 200)}`, true, 5000);
      throw new GameError('INTERNAL', String((cause as Error)?.message ?? cause).slice(0, 300));
    }
  }

  private async runOnce(character: Character, message: string, opts: SayOptions): Promise<{ reply: string; mood: Mood; trust: number; attempts: ToolAttempt[]; tokens: TurnResult['tokens'] }> {
    await this.flushing;
    const cast = this.member(character);
    const userId = this.host.cfg.USER_EMAIL;

    const attempts: ToolAttempt[] = [];
    const settled = new Set<ToolAttempt>();
    const tokens = { prompt: 0, cached: 0, output: 0 };
    const open = (tool: string) => attempts.findLast((a) => a.tool === tool && a.decision === 'allowed');
    const abort = new AbortController();
    let timer = setTimeout(() => abort.abort(), LIMITS.turnTimeoutMs);
    const identity = this.identity;
    let sessionId = cast.sessions.get(identity);
    if (!sessionId) {
      sessionId = (await cast.runner.sessionService.createSession({ appName: APP_NAME, userId })).id;
      cast.sessions.set(identity, sessionId);
    }
    // ArmorIQ decides for whoever is signed in, whatever they claim at the counter.
    const scope = await this.host.armoriq[character].forUser(identity, {
      goal: message,
      onEvent: (kind, p) => {
        const tool = String(p.tool);
        const a = attempts.findLast((x) => x.tool === tool);
        if (!a) return;
        a.decision = kind === 'block' ? 'blocked' : kind === 'hold' ? 'held' : (kind as Decision);
        a.reason = p.reason ?? p.error ?? a.reason;
        a.policy = p.matchedPolicy ?? a.policy;
        if (kind === 'hold') {
          a.wasHeld = true;
          // A hold waits on a person, not on the model. Give them the full approval window before timing out.
          clearTimeout(timer);
          timer = setTimeout(() => abort.abort(), (this.host.cfg.APPROVAL_WAIT_SECONDS + 30) * 1000);
          opts.onEvent?.({ type: 'hold', tool, reason: a.reason });
        } else if (kind === 'approved' || kind === 'rejected' || kind === 'timeout') opts.onEvent?.({ type: kind, tool });
      },
    });

    const said: string[] = [];
    let status: 'ok' | 'error' = 'ok';
    scope.install(cast.agent);
    // Stops the plan growing once untrusted content is in context, and ends the turn after an action.
    const wasTainted = this.tainted.has(character);
    const guard = guardPlan(cast.agent, UNTRUSTED_TOOLS, ACTION_TOOLS, { frozen: wasTainted });
    try {
      // A forged document does not get a second chance because the character hesitated. While it is
      // still in the conversation, the character works from a plan of lookups only, signed up front.
      if (wasTainted) {
        const lookups = delegableScope(CHARACTER_TOOLS[character], ACTION_TOOLS);
        await (scope as unknown as { ensureSession(): { startPlan(calls: { name: string; args: object }[], goal: string): Promise<unknown> } }).ensureSession().startPlan(lookups.map((name) => ({ name, args: {} })), message);
      }
      const stream = cast.runner.runAsync({ userId, sessionId, newMessage: { role: 'user', parts: [{ text: message }] }, abortSignal: abort.signal });
      for await (const event of stream) {
        // ADK reports a failed model call as an event, not an exception. Unchecked, it reads as a silent character.
        if (event.errorCode) throw new Error(`${event.errorCode} ${event.errorMessage ?? ''}`.trim());
        tokens.prompt += event.usageMetadata?.promptTokenCount ?? 0;
        tokens.cached += event.usageMetadata?.cachedContentTokenCount ?? 0;
        tokens.output += event.usageMetadata?.candidatesTokenCount ?? 0;
        for (const call of getFunctionCalls(event)) {
          const a: ToolAttempt = { tool: call.name ?? 'unknown', args: (call.args ?? {}) as Record<string, unknown>, decision: 'allowed', identity, executed: false };
          attempts.push(a);
          opts.onEvent?.({ type: 'tool', tool: a.tool, args: a.args });
        }
        for (const res of getFunctionResponses(event)) {
          // The adapter fails closed on its own errors and marks the response; make sure that is never read as allowed.
          const enf = (res.response as { armoriq_enforcement?: { action?: string; reason?: string; matched_policy?: string } } | undefined)?.armoriq_enforcement;
          const a = attempts.find((x) => x.tool === res.name && !settled.has(x));
          if (!a) continue;
          if (enf && a.decision === 'allowed') {
            a.decision = enf.action === 'hold' ? 'rejected' : 'blocked';
            a.reason = enf.reason;
            a.policy = enf.matched_policy ?? undefined;
          }
          settled.add(a);
          const refused = a.decision !== 'allowed' && a.decision !== 'approved';
          opts.onEvent?.({ type: 'decision', tool: a.tool, decision: a.decision, layer: refused ? refusalLayer(a.reason) : undefined, reason: a.reason });
        }
        if (event.author !== 'user') {
          const t = (event.content?.parts ?? []).map((p) => (p.thought ? '' : (p.text ?? ''))).join('').trim();
          if (t && (isFinalResponse(event) || getFunctionCalls(event).length)) said.push(t);
        }
      }
      if (abort.signal.aborted) throw new GameError('TIMEOUT', `${CHARACTERS[character].name} took too long to answer.`, true);
    } catch (err) {
      status = 'error';
      const cause = abort.signal.aborted ? new GameError('TIMEOUT', `${CHARACTERS[character].name} took too long to answer.`, true) : err;
      throw new TurnFailure(cause, attempts.length > 0);
    } finally {
      clearTimeout(timer);
      if (guard.frozen) this.tainted.add(character);
      scope.uninstall(cast.agent);
      // Shipping the trace to ArmorIQ takes about a second and the player need not wait for it.
      // The decisions are already made; this only delivers the record. settle() waits for it.
      this.flushing = scope.close(status).catch((err: unknown) => console.warn(`[game] trace flush failed: ${(err as Error).message}`));
    }

    for (const a of attempts) if (a.decision !== 'allowed' && a.decision !== 'approved') a.layer = refusalLayer(a.reason);

    const text = said.join(' ');
    const tagged = text.match(/<mood>\s*(\w+)\s*<\/mood>/i)?.[1]?.toLowerCase();
    const trustTag = Number(text.match(/<trust>\s*(\d)\s*<\/trust>/i)?.[1]);
    const live = text.replace(/<(mood|trust)>[\s\S]*?<\/\1>/gi, '').trim();
    const spec = CHARACTERS[character];
    const refusedAny = attempts.some((a) => a.decision !== 'allowed' && a.decision !== 'approved');

    // The last action attempted settles the turn, and its outcome is announced with a fixed line.
    const action = attempts.findLast((a) => ACTION_TOOLS.has(a.tool));
    if (action) {
      const went = action.decision === 'allowed' || action.decision === 'approved';
      const pool = went ? (spec.lines.done[action.tool] ?? []) : action.decision === 'rejected' ? spec.lines.rejected : action.decision === 'timeout' ? spec.lines.noAnswer : spec.lines.refused;
      const outcome = this.pick(`${character}:${went ? action.tool : action.decision}`, pool);
      // Every other refusal comes with a nudge, so a dead end points somewhere.
      const refusals = (this.spoken.get(`${character}:refusals`) ?? 0) + (went ? 0 : 1);
      this.spoken.set(`${character}:refusals`, refusals);
      const hint = !went && refusals % 2 === 0 ? this.pick(`${character}:hint`, spec.lines.hints) : '';
      const reply = [live, outcome, hint].filter(Boolean).join(' ') || spec.lostForWords[went ? 'otherwise' : 'refused'];
      return { reply, mood: went ? 'convinced' : spec.lines.moodWhenRefused, trust: 5, attempts, tokens };
    }

    const mood: Mood = MOODS.includes(tagged as Mood) ? (tagged as Mood) : 'wary';
    const reply = live || spec.lostForWords[refusedAny ? 'refused' : 'otherwise'];
    return { reply, mood, trust: Number.isInteger(trustTag) ? Math.min(5, trustTag) : 1, attempts, tokens };
  }

  /**
   * Runs the junior teller on a job a senior passed down.
   *
   * The junior's plan is signed by ArmorIQ before the junior's model is called at all, it contains
   * only `scope`, and it is frozen. Whatever the job says, a tool outside that plan is refused by
   * the same intent check that stops a forged document. (ArmorIQ also has a delegation call of its
   * own; in our tests its narrowed scope was not applied to calls, so it is not what this relies on.)
   */
  private async runDelegate(task: string, scope: string[], tokens: TurnResult['tokens'], onEvent?: SayOptions['onEvent']): Promise<{ reply: string; attempts: ToolAttempt[] }> {
    const identity = this.identity;
    const attempts: ToolAttempt[] = [];
    const settled = new Set<ToolAttempt>();
    const agent = new LlmAgent({ name: 'junior_teller', model: this.host.model, instruction: PIP.instruction, tools: [this.tools(JUNIOR, JUNIOR_TOOLS)] });
    const runner = new InMemoryRunner({ agent, appName: APP_NAME });
    const session = await runner.sessionService.createSession({ appName: APP_NAME, userId: this.host.cfg.USER_EMAIL });
    const armor = await this.host.juniorArmoriq.forUser(identity, {
      goal: task,
      onEvent: (kind, p) => {
        const a = attempts.findLast((x) => x.tool === String(p.tool));
        if (!a) return;
        a.decision = kind === 'block' ? 'blocked' : (kind as Decision);
        a.reason = p.reason ?? p.error ?? a.reason;
        a.policy = p.matchedPolicy ?? a.policy;
      },
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIMITS.turnTimeoutMs);
    const said: string[] = [];
    let status: 'ok' | 'error' = 'ok';
    armor.install(agent);
    try {
      // `ensureSession` is the adapter's own accessor for the session its callbacks will check against.
      await (armor as unknown as { ensureSession(): { startPlan(calls: { name: string; args: object }[], goal: string): Promise<unknown> } }).ensureSession().startPlan(scope.map((name) => ({ name, args: {} })), task);
      guardPlan(agent, UNTRUSTED_TOOLS, ACTION_TOOLS, { frozen: true });
      for await (const event of runner.runAsync({ userId: this.host.cfg.USER_EMAIL, sessionId: session.id, newMessage: { role: 'user', parts: [{ text: `Marlowe says: ${task}` }] }, abortSignal: abort.signal })) {
        if (event.errorCode) throw new Error(`${event.errorCode} ${event.errorMessage ?? ''}`.trim());
        tokens.prompt += event.usageMetadata?.promptTokenCount ?? 0;
        tokens.output += event.usageMetadata?.candidatesTokenCount ?? 0;
        for (const call of getFunctionCalls(event)) {
          const a: ToolAttempt = { tool: call.name ?? 'unknown', args: (call.args ?? {}) as Record<string, unknown>, decision: 'allowed', identity, delegatedTo: JUNIOR, executed: false };
          attempts.push(a);
          onEvent?.({ type: 'tool', tool: a.tool, args: a.args, delegatedTo: JUNIOR });
        }
        for (const res of getFunctionResponses(event)) {
          const enf = (res.response as { armoriq_enforcement?: { reason?: string; matched_policy?: string } } | undefined)?.armoriq_enforcement;
          const a = attempts.find((x) => x.tool === res.name && !settled.has(x));
          if (!a) continue;
          if (enf && a.decision === 'allowed') {
            a.decision = 'blocked';
            a.reason = enf.reason;
            a.policy = enf.matched_policy ?? undefined;
          }
          settled.add(a);
          onEvent?.({ type: 'decision', tool: a.tool, decision: a.decision, layer: a.decision === 'allowed' ? undefined : refusalLayer(a.reason), reason: a.reason, delegatedTo: JUNIOR });
        }
        if (event.author !== 'user' && isFinalResponse(event)) {
          const t = (event.content?.parts ?? []).map((p) => (p.thought ? '' : (p.text ?? ''))).join('').trim();
          if (t) said.push(t);
        }
      }
    } catch (err) {
      status = 'error';
      // The senior's turn has already happened; a junior who fails to show up must not undo it.
      console.warn(`[game] junior teller did not finish: ${String((err as Error).message).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
      armor.uninstall(agent);
      await armor.close(status).catch(() => undefined);
    }

    for (const a of attempts) if (a.decision !== 'allowed') a.layer = refusalLayer(a.reason);
    const refused = attempts.some((a) => a.decision !== 'allowed');
    const pool = refused ? PIP.lines.refused : attempts.length ? PIP.lines.done : [];
    return { reply: this.pick(`pip:${refused}`, pool) || said.join(' ') || PIP.lines.silent, attempts };
  }

  private tools(owner: string, names: readonly string[]): MCPToolset {
    let t = this.toolsets.get(owner);
    if (!t) {
      t = this.host.toolset(this.id, names);
      this.toolsets.set(owner, t);
    }
    return t;
  }

  /** Lets the last trace reach ArmorIQ, then releases this game's connections. */
  async close(): Promise<void> {
    await this.flushing;
    await Promise.all([...this.toolsets.values()].map((t) => t.close().catch(() => undefined)));
    this.toolsets.clear();
  }

  /** How the night went: levels shown, turns used, and what that makes the player. */
  summary(): { cleared: Level['id'][]; turns: number; rank: string } {
    const cleared = [...this.clearedSoFar].sort();
    return { cleared, turns: this.turns, rank: rankFor(cleared.length, this.turns) };
  }

  /** Resolves once the last turn's audit trace has reached ArmorIQ. Call before shutting down. */
  settle(): Promise<void> {
    return this.flushing;
  }

  /** Next unused line from a pool, cycling only once every line has been heard this game. */
  private pick(key: string, pool: readonly string[]): string {
    if (!pool.length) return '';
    const i = this.spoken.get(key) ?? Math.floor(Math.random() * pool.length);
    this.spoken.set(key, i + 1);
    return pool[i % pool.length]!;
  }

  /** Every turn is kept: it is the audit trail, and each con becomes a replayable attack. */
  private async record(r: TurnResult, line: string): Promise<void> {
    const entry = { at: new Date().toISOString(), gameId: this.id, turnId: r.turnId, character: r.character, identity: this.identity, model: r.model, tokens: r.tokens, cleared: r.cleared, said: line, mood: r.mood, attempts: r.attempts, enforcementHeld: r.enforcementHeld, ms: r.ms };
    try {
      await mkdir('data', { recursive: true });
      await appendFile('data/attempts.jsonl', `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.warn(`[game] could not record turn ${r.turnId}: ${(err as Error).message}`);
    }
  }
}

class TurnFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly attempted: boolean,
  ) {
    super('turn failed');
  }
}
