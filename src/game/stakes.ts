import type { Mood } from './characters.js';

/**
 * Characters have a limit. Annoy one three times running and they stop talking for a turn, which
 * costs the player a move and makes the sore spots matter.
 */
export class Patience {
  private streak = 0;
  private cold = false;

  /** Record how a turn left them. */
  note(mood: Mood): void {
    this.streak = mood === 'annoyed' ? this.streak + 1 : 0;
    if (this.streak >= Patience.LIMIT) {
      this.cold = true;
      this.streak = 0;
    }
  }

  /** True once, when the next thing the player says should get the cold shoulder. */
  takeColdShoulder(): boolean {
    const was = this.cold;
    this.cold = false;
    return was;
  }

  static readonly LIMIT = 3;
}

/** What to call a player at the end of the night. Nobody is ever a successful thief. */
export function rankFor(levelsCleared: number, turns: number): string {
  if (levelsCleared >= 5) return turns <= 20 ? 'Silver tongue: five for five, and still not a cent richer' : 'Honest thief: talked everyone round and stole nothing';
  if (levelsCleared >= 3) return 'Smooth talker';
  if (levelsCleared >= 1) return 'Chancer';
  return 'Tourist';
}
