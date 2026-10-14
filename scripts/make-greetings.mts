/**
 * Records each character's opening line once, in their own ElevenLabs voice, as a static file
 * the game plays the instant a conversation opens. No credits are spent on greetings during play,
 * and they also play in the recorded tour.
 *
 *   set -a; . ./.env; set +a; npx tsx scripts/make-greetings.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CAST } from '../frontend/src/contract.ts';
import { VOICES } from '../src/voice/lines.ts';

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Set ELEVENLABS_API_KEY first.');
const out = new URL('../frontend/public/audio/voice/', import.meta.url);
mkdirSync(out, { recursive: true });

for (const [id, cast] of Object.entries(CAST)) {
  const v = VOICES[id];
  if (!v) continue;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: cast.greeting, model_id: 'eleven_multilingual_v2', voice_settings: { stability: v.stability, similarity_boost: 0.75, style: v.style, speed: v.speed } }),
  });
  if (!res.ok) throw new Error(`${id}: ElevenLabs ${res.status} ${(await res.text()).slice(0, 200)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(new URL(`${id}.mp3`, out), audio);
  console.log(`${id}.mp3  ${audio.length} bytes  "${cast.greeting}"`);
}
