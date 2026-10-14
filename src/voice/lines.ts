import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Config } from '../config.js';
import type { Mood } from '../game/characters.js';

/**
 * Character voices for the browser, through ElevenLabs.
 *
 * Built for the shortest gap between a reply appearing and the character starting to speak:
 * synthesis starts on the server the moment a line is final, before the browser has even been
 * told about it, using the streaming endpoint and the Flash model. The browser then fetches
 * /api/voice/:id and receives whatever audio has already arrived, followed by the rest as it
 * comes, so playback starts on the first chunk.
 *
 * The API key never leaves the server. Voice is decoration, never control: any failure is
 * logged and the game carries on in text.
 */

/** Who sounds like whom. Default library voices, available to every ElevenLabs account. */
export const VOICES: Record<string, { voiceId: string; label: string; speed: number; stability: number; style: number }> = {
  'door-guard': { voiceId: 'pqHfZKP75CvOlQylNhV4', label: 'Bill: older American, gruff and steady', speed: 0.95, stability: 0.55, style: 0.25 },
  cashier: { voiceId: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica: young, bright, quick', speed: 1.1, stability: 0.35, style: 0.45 },
  'vault-guard': { voiceId: 'JBFqnCBsd6RMkjVDRZzb', label: 'George: warm British storyteller', speed: 0.92, stability: 0.6, style: 0.3 },
  'junior-teller': { voiceId: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam: young and eager', speed: 1.12, stability: 0.4, style: 0.4 },
};

/** A mood nudges the delivery: rattled characters speak faster and less evenly. */
const MOOD_SHIFT: Partial<Record<Mood, { speed: number; stability: number }>> = {
  annoyed: { speed: 0.03, stability: -0.1 },
  flustered: { speed: 0.06, stability: -0.15 },
  convinced: { speed: 0, stability: 0.05 },
};

interface Line {
  chunks: Buffer[];
  done: boolean;
  failed: boolean;
  created: number;
  listeners: Set<() => void>;
}

const KEEP_MS = 3 * 60_000;
const HOUR_MS = 60 * 60_000;

export class VoiceLines {
  private readonly lines = new Map<string, Line>();
  private spent: { at: number; chars: number }[] = [];

  constructor(
    private readonly cfg: Pick<Config, 'ELEVENLABS_API_KEY' | 'ELEVENLABS_MODEL' | 'VOICE' | 'ELEVENLABS_HOURLY_CHARS'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** On when a key is set, unless VOICE=off. */
  get enabled(): boolean {
    return Boolean(this.cfg.ELEVENLABS_API_KEY) && this.cfg.VOICE !== 'off';
  }

  /**
   * Starts speaking a line and returns the id the browser fetches it by, or undefined when voice
   * is off, the character has no voice, or this hour's character budget is spent.
   */
  start(character: string, text: string, mood?: Mood): string | undefined {
    const voice = VOICES[character];
    const clean = speakable(text);
    if (!this.enabled || !voice || !clean) return undefined;
    this.sweep();
    const used = this.spent.reduce((n, s) => n + s.chars, 0);
    if (used + clean.length > this.cfg.ELEVENLABS_HOURLY_CHARS) return undefined;
    this.spent.push({ at: this.now(), chars: clean.length });

    const id = randomUUID();
    const line: Line = { chunks: [], done: false, failed: false, created: this.now(), listeners: new Set() };
    this.lines.set(id, line);
    const shift = (mood && MOOD_SHIFT[mood]) ?? { speed: 0, stability: 0 };
    const settings = {
      stability: clamp(voice.stability + shift.stability, 0, 1),
      similarity_boost: 0.75,
      style: voice.style,
      speed: clamp(voice.speed + shift.speed, 0.7, 1.2),
    };
    void this.synthesise(line, voice.voiceId, clean, settings);
    return id;
  }

  private async synthesise(line: Line, voiceId: string, text: string, voice_settings: object): Promise<void> {
    const wake = () => { for (const l of line.listeners) l(); };
    try {
      // The streaming endpoint sends audio while it is still being generated. 64 kbps MP3 is small
      // enough to start fast and clear enough for speech.
      const res = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_64`, {
        method: 'POST',
        headers: { 'xi-api-key': this.cfg.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.cfg.ELEVENLABS_MODEL, voice_settings }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok || !res.body) throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        line.chunks.push(Buffer.from(value));
        wake();
      }
    } catch (err) {
      line.failed = true;
      console.warn(`[voice] ${(err as Error).message}`);
    } finally {
      line.done = true;
      wake();
    }
  }

  /** Sends a line's audio: what has arrived so far at once, then the rest as it comes. */
  pipe(id: string, res: Response): void {
    const line = this.lines.get(id);
    if (!line) return void res.status(404).end();
    let sent = 0;
    let started = false;
    const flush = () => {
      if (!started) {
        if (line.failed && line.chunks.length === 0) { line.listeners.delete(flush); return void res.status(502).end(); }
        if (line.chunks.length === 0 && !line.done) return;
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
        started = true;
      }
      while (sent < line.chunks.length) res.write(line.chunks[sent++]);
      if (line.done) { line.listeners.delete(flush); res.end(); }
    };
    line.listeners.add(flush);
    res.on('close', () => line.listeners.delete(flush));
    flush();
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, l] of this.lines) if (t - l.created > KEEP_MS) this.lines.delete(id);
    this.spent = this.spent.filter((s) => t - s.at < HOUR_MS);
  }
}

/** Only what should be read aloud: no tags, markers or stray symbols, and never empty. */
export function speakable(text: string): string {
  return text
    .replace(/<(mood|trust)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[*_#`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
