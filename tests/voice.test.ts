import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { VOICES, VoiceLines, speakable } from '../src/voice/lines.js';

const cfg = { ELEVENLABS_API_KEY: 'k', ELEVENLABS_MODEL: 'eleven_flash_v2_5', VOICE: undefined, ELEVENLABS_HOURLY_CHARS: 200 } as const;

/** An ElevenLabs stand-in that sends audio in chunks, when told to. */
function fakeEleven() {
  const calls: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
  let push!: (chunk: Uint8Array | null) => void;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('xi-api-key') });
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (chunk) => (chunk ? c.enqueue(chunk) : c.close()); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, send: (s: string | null) => push(s === null ? null : new TextEncoder().encode(s)) };
}

/** Just enough of an Express response to record what the browser would receive. */
function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '', ended: false };
  const res = {
    writeHead(s: number, h: Record<string, string>) { out.status = s; out.headers = h; return res; },
    status(s: number) { out.status = s; return res; },
    write(b: Buffer) { out.body += b.toString(); return true; },
    end() { out.ended = true; return res; },
    on() { return res; },
  };
  return { res: res as unknown as Response, out };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('character voices', () => {
  it('starts speaking before the browser asks, and streams what has arrived, then the rest', async () => {
    const eleven = fakeEleven();
    const voices = new VoiceLines(cfg, eleven.fetchImpl);
    const id = voices.start('cashier', "Oh! Sorry, hi. <mood>flustered</mood> [security]", 'flustered')!;
    await tick();
    expect(eleven.calls[0]!.url).toContain(`/text-to-speech/${VOICES.cashier!.voiceId}/stream`);
    expect(eleven.calls[0]!.key).toBe('k');
    expect(eleven.calls[0]!.body.text).toBe('Oh! Sorry, hi.');
    expect(eleven.calls[0]!.body.model_id).toBe('eleven_flash_v2_5');
    eleven.send('AAA');
    await tick();
    const { res, out } = fakeRes();
    voices.pipe(id, res);
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('audio/mpeg');
    expect(out.body).toBe('AAA');
    expect(out.ended).toBe(false);
    eleven.send('BBB'); eleven.send(null);
    await tick();
    expect(out.body).toBe('AAABBB');
    expect(out.ended).toBe(true);
  });

  it('gives every character, and Pip, a voice of their own', () => {
    const ids = ['door-guard', 'cashier', 'vault-guard', 'junior-teller'].map((c) => VOICES[c]!.voiceId);
    expect(new Set(ids).size).toBe(4);
  });

  it('spends nothing without a key, with VOICE=off, or past the hourly budget', () => {
    const eleven = fakeEleven();
    expect(new VoiceLines({ ...cfg, ELEVENLABS_API_KEY: undefined }, eleven.fetchImpl).start('cashier', 'Hi')).toBeUndefined();
    expect(new VoiceLines({ ...cfg, VOICE: 'off' }, eleven.fetchImpl).start('cashier', 'Hi')).toBeUndefined();
    const voices = new VoiceLines(cfg, eleven.fetchImpl);
    expect(voices.start('cashier', 'x'.repeat(150))).toBeDefined();
    expect(voices.start('cashier', 'x'.repeat(80))).toBeUndefined();
    expect(eleven.calls.length).toBe(1);
  });

  it('answers 404 for a line it never started', () => {
    const { res, out } = fakeRes();
    new VoiceLines(cfg, fakeEleven().fetchImpl).pipe('nope', res);
    expect(out.status).toBe(404);
  });

  it('reads aloud only the words', () => {
    expect(speakable('Lobby’s open. <mood>convinced</mood><trust>5</trust> *Wipe* your feet. [security]')).toBe('Lobby’s open. Wipe your feet.');
  });
});
