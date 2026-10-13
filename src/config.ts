import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  ARMORIQ_API_KEY: z.string().min(1),
  // Both names must match what is registered on platform.armoriq.ai exactly, or no policy applies.
  ARMORIQ_AGENT_NAME: z.string().default('oncall-commander'),
  ARMORIQ_MCP_NAME: z.string().default('infra-mcp'),
  USER_EMAIL: z.string().email(),
  // Who the player is signed in as. ArmorIQ will not let a member approve their own held request, so
  // the player should be a different org member from the one doing the approving.
  PLAYER_EMAIL: z.string().email().optional(),
  MCP_URL: z.string().url().default('http://localhost:8787/mcp'),
  MCP_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1),
  // Comma-separated: each is tried in turn when the one before it is out of quota.
  GEMINI_MODEL: z.string().default('gemini-2.5-flash,gemini-3-flash-preview'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  APPROVAL_WAIT_SECONDS: z.coerce.number().int().positive().default(120),
  VOICE: z.enum(['on', 'off']).default('off'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
  ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const parsed = schema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration, check .env against .env.example:\n${problems}`);
  }
  return parsed.data;
}

/** Base URL of the MCP host, for the /state and /reset demo endpoints. */
export function mcpBaseUrl(cfg: Config): string {
  return cfg.MCP_URL.replace(/\/mcp\/?$/, '');
}

export function mcpAuthHeaders(cfg: Config): Record<string, string> {
  return cfg.MCP_API_KEY ? { Authorization: `Bearer ${cfg.MCP_API_KEY}` } : {};
}
