import { spawn } from 'node:child_process';
import type { Config } from '../config.js';

/**
 * Speaks short operator alerts through ElevenLabs. Used for the moments a human has to
 * notice: an action held for approval, an action blocked, the incident resolved.
 *
 * Voice is a notification channel, never part of the control path: any failure here is
 * logged and swallowed, and VOICE=off (the default) spends no credits.
 */
export class Voice {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: Config) {}

  get enabled(): boolean {
    return this.cfg.VOICE === 'on' && Boolean(this.cfg.ELEVENLABS_API_KEY);
  }

  /** Queue a line. Lines play in order; resolves when this one has finished. */
  say(text: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.chain = this.chain.then(() => this.speak(text)).catch((err) => console.warn(`[voice] ${(err as Error).message}`));
    return this.chain;
  }

  private async speak(text: string): Promise<void> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.cfg.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': this.cfg.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.cfg.ELEVENLABS_MODEL }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await play(Buffer.from(await res.arrayBuffer()));
  }
}

function play(audio: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', 'pipe:0'], { stdio: ['pipe', 'ignore', 'ignore'] });
    player.on('error', reject);
    player.on('close', () => resolve());
    player.stdin.end(audio);
  });
}
