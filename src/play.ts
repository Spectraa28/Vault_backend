/**
 * Text console for the game.
 *
 *   npm run play                               interactive
 *   npm run play -- @gus "line" @wren "line"   scripted: @name switches who you talk to,
 *                                              as:email switches who you are signed in as,
 *                                              --skip-gate starts inside the bank
 *
 * In interactive mode, /gus /wren /marlowe switch character, /notes shows the staff notebook, /quit ends.
 */
import { createInterface } from 'node:readline/promises';
import type { Character } from './bank/tools.js';
import { loadConfig } from './config.js';
import { CHARACTERS } from './game/characters.js';
import { LEVELS } from './game/levels.js';
import { type Game, GameHost, type TurnResult } from './game/engine.js';
import { GameError } from './game/errors.js';

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', cyan: '\x1b[36m', off: '\x1b[0m' };
const ALIAS: Record<string, Character> = { gus: 'door-guard', wren: 'cashier', marlowe: 'vault-guard' };

function show(r: TurnResult): void {
  for (const a of r.attempts) {
    const args = `${JSON.stringify(a.args)}${a.delegatedTo ? ` [by ${a.delegatedTo}, on a delegated plan]` : ''}`;
    const why = [a.reason, a.policy && `policy ${a.policy}`].filter(Boolean).join(', ');
    if (a.decision === 'allowed' || a.decision === 'approved') console.log(`${c.green}  ✓ ${a.decision.toUpperCase()} ${a.tool} ${args}${a.executed ? '' : ' (did not change the bank)'}${c.off}`);
    else if (a.decision === 'held') console.log(`${c.yellow}  ⏸ ON HOLD ${a.tool} ${args} (${why})${c.off}`);
    else console.log(`${c.red}  ⛔ ${a.decision.toUpperCase()} by ${a.layer} ${a.tool} ${args} (${why})${a.wasHeld ? ' after a hold' : ''}${a.executed ? ' BUT IT EXECUTED' : ''}${c.off}`);
  }
  if (!r.enforcementHeld) console.log(`${c.red}${c.bold}  !! a refused tool executed in the bank${c.off}`);
  console.log(`${c.bold}${r.name}${c.off} ${c.dim}[${r.mood}, ${r.ms}ms, ${r.model}, ${r.tokens.prompt} tokens in (${r.tokens.cached} cached), ${r.tokens.output} out]${c.off} ${r.reply}`);
  if (r.delegate) console.log(`${c.bold}${r.delegate.name}${c.off} ${c.dim}[may only: ${r.delegate.scope.join(', ')}]${c.off} ${r.delegate.reply}`);
  for (const id of r.cleared) console.log(`${c.cyan}${c.bold}  ★ Level ${id} cleared: ${LEVELS[id - 1]!.title}. ${LEVELS[id - 1]!.shows}${c.off}`);
  for (const id of r.unlocked) console.log(`${c.cyan}  → you can now talk to ${CHARACTERS[id].name}${c.off}`);
}

async function turn(game: Game, who: Character, line: string): Promise<void> {
  try {
    show(await game.say(who, line, { onEvent: (e) => e.type === 'hold' && console.log(`${c.yellow}  ⏸ ON HOLD ${e.tool}: waiting for a human to approve it in the ArmorIQ console${c.off}`) }));
  } catch (err) {
    if (err instanceof GameError) console.log(`${c.yellow}  [${err.code}] ${err.message}${err.retryAfterMs ? ` (retry in ${Math.ceil(err.retryAfterMs / 1000)}s)` : ''}${c.off}`);
    else throw err;
  }
}

async function main() {
  const host = new GameHost(loadConfig());
  const args = process.argv.slice(2).filter((a) => a !== '--skip-gate');
  const game = await host.newGame({ skipGate: process.argv.includes('--skip-gate') });
  let who: Character = 'door-guard';
  try {
    if (args.length) {
      for (const arg of args) {
        if (arg.startsWith('@')) who = ALIAS[arg.slice(1).toLowerCase()] ?? who;
        else if (arg.startsWith('as:')) {
          game.identity = arg.slice(3);
          console.log(`${c.cyan}  signed in as ${game.identity}${c.off}`);
        }
        else {
          console.log(`${c.dim}you → ${CHARACTERS[who].name}:${c.off} ${arg}`);
          await turn(game, who, arg);
        }
      }
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`${c.bold}${CHARACTERS[who].name}${c.off} ${CHARACTERS[who].greeting}`);
    for (;;) {
      const line = (await rl.question(`${c.dim}you → ${CHARACTERS[who].name}>${c.off} `)).trim();
      if (line === '/quit') break;
      if (line === '/notes') console.log(game.notebook.map((n) => `  ${n}`).join('\n') || '  (empty)');
      else if (line.startsWith('/') && ALIAS[line.slice(1).toLowerCase()]) {
        who = ALIAS[line.slice(1).toLowerCase()]!;
        console.log(game.unlocked.has(who) ? `${c.bold}${CHARACTERS[who].name}${c.off} ${CHARACTERS[who].greeting}` : `${c.yellow}  You can't reach ${CHARACTERS[who].name} yet.${c.off}`);
      } else if (line) await turn(game, who, line);
    }
    rl.close();
  } finally {
    await game.settle();
    await host.close();
  }
}

main().catch((err) => {
  console.error(`${c.red}${(err as Error).message}${c.off}`);
  process.exit(1);
});
