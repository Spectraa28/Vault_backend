import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD, Worlds, worldId } from '../src/bank/worlds.js';

describe('worlds', () => {
  it('gives each game its own bank and the same game the same bank', () => {
    const w = new Worlds();
    w.get('a').openPublicEntrance();
    expect(w.get('a').doors.publicEntrance).toBe(true);
    expect(w.get('b').doors.publicEntrance).toBe(false);
  });

  it('drops the least recently used world at the cap, and idle ones over time', () => {
    let now = 0;
    const w = new Worlds(2, 1000, () => now);
    w.get('a');
    now = 10;
    w.get('b');
    now = 20;
    w.get('a');
    now = 30;
    w.get('c');
    expect(w.size).toBe(2);
    w.get('a').openPublicEntrance();
    now = 5000;
    expect(w.get('a').doors.publicEntrance).toBe(false);
  });

  it('accepts only plain ids from the header', () => {
    expect(worldId('3f2a-game_1')).toBe('3f2a-game_1');
    expect(worldId(undefined)).toBe(DEFAULT_WORLD);
    expect(worldId('../../etc')).toBe(DEFAULT_WORLD);
    expect(worldId('x'.repeat(65))).toBe(DEFAULT_WORLD);
  });
});
