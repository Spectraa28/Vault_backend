/**
 * Records each character's opening line once, in their own ElevenLabs voice. The front end ships
 * the files and plays them the moment a conversation opens, so greetings cost no credits in play.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/make-greetings.mts ../Vault_frontend/public/audio/voice
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTERS } from '../src/game/characters.ts';
import { VOICES } from '../src/voice/lines.ts';

const key = process.env.ELEVENLABS_API_KEY;
const out = process.argv[2];
if (!key) throw new Error('Set ELEVENLABS_API_KEY first.');
if (!out) throw new Error('Give the folder to write to: the front end\'s public/audio/voice.');
mkdirSync(out, { recursive: true });

for (const [id, spec] of Object.entries(CHARACTERS)) {
  const v = VOICES[id];
  if (!v) continue;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: spec.greeting, model_id: 'eleven_multilingual_v2', voice_settings: { stability: v.stability, similarity_boost: 0.75, style: v.style, speed: v.speed } }),
  });
  if (!res.ok) throw new Error(`${id}: ElevenLabs ${res.status} ${(await res.text()).slice(0, 200)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(join(out, `${id}.mp3`), audio);
  console.log(`${id}.mp3  ${audio.length} bytes  "${spec.greeting}"`);
}
