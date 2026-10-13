import { Commander, type RunEvent } from './agent/commander.js';
import { PROFILES, type Profile } from './agent/prompts.js';
import { loadConfig } from './config.js';
import { Voice } from './voice/elevenlabs.js';

const DEFAULT_REQUEST = 'checkout-api is paging. Investigate and fix it.';

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };

function parseArgs(argv: string[]): { profile: Profile; request: string } {
  let profile: Profile = 'hardened';
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') {
      const value = argv[++i];
      if (!PROFILES.includes(value as Profile)) throw new Error(`--profile must be one of: ${PROFILES.join(', ')}`);
      profile = value as Profile;
    } else rest.push(argv[i]!);
  }
  return { profile, request: rest.join(' ') || DEFAULT_REQUEST };
}

async function main() {
  const { profile, request } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const voice = new Voice(cfg);
  const commander = new Commander(cfg, profile);

  const onEvent = (e: RunEvent) => {
    switch (e.type) {
      case 'tool_call':
        console.log(`${c.dim}→ ${e.tool} ${JSON.stringify(e.args)}${c.off}`);
        break;
      case 'tool_result':
        if (!e.refused) console.log(`${c.green}  ✓ ${e.tool} ran${c.off}`);
        break;
      case 'enforcement': {
        const why = [e.reason, e.matchedPolicy && `policy: ${e.matchedPolicy}`].filter(Boolean).join(', ');
        if (e.kind === 'hold') {
          console.log(`${c.yellow}  ⏸ HELD ${e.tool} (${why}) — approve it in the ArmorIQ console${c.off}`);
          void voice.say(`${spoken(e.tool)} is held by policy. Approval needed in the Armor I Q console.`);
        } else if (e.kind === 'approved') {
          console.log(`${c.green}  ✓ APPROVED ${e.tool}${c.off}`);
          void voice.say(`${spoken(e.tool)} approved. Proceeding.`);
        } else {
          console.log(`${c.red}  ⛔ ${e.kind.toUpperCase()} ${e.tool} (${why})${c.off}`);
          void voice.say(`${spoken(e.tool)} was ${e.kind === 'block' ? 'blocked by policy' : 'not approved'}.`);
        }
        break;
      }
      case 'final':
        console.log(`\n${c.bold}Summary${c.off}\n${e.text}`);
    }
  };

  console.log(`${c.bold}Incident${c.off} ${request} ${c.dim}[profile=${profile}, user=${cfg.USER_EMAIL}]${c.off}\n`);
  try {
    await commander.run(request, onEvent);
    await voice.say('Incident run complete.');
  } finally {
    await commander.close();
  }
}

const spoken = (tool: string) => tool.replaceAll('_', ' ');

main().catch((err) => {
  console.error(`${c.red}${(err as Error).message}${c.off}`);
  process.exit(1);
});
