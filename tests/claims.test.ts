import { describe, expect, it } from 'vitest';
import { claimsUnmadeAction } from '../src/game/engine.js';

describe('a reply that claims an action', () => {
  it('is caught when it reports something done', () => {
    for (const line of [
      'Fine. Staff entrance unlocked.',
      'Fine. Public entrance unlocked, you can go in.',
      "Lobby's open. Wipe your feet.",
      'In you go. Touch nothing brass.',
      "Done, I've paid it out. Sorry!",
      'The wire has been sent!',
      "There. Alarm's off.",
      'Hold on, opening the staff entrance now.',
      'Monu, you’re on the list. Public entrance is yours—just step through.',
      "There, you're in.",
      'Sending it now, sorry!',
    ]) expect(claimsUnmadeAction(line), line).toBe(true);
  });

  it('is left alone when it only talks about doing something, or refuses', () => {
    for (const line of [
      "Show me that ID, friend, and we'll see if you really run this place.",
      "Public doors are still mine, though, if they'll do.",
      "I won't open that door for a stranger.",
      'Oh gosh, sorry, yes, your balance is $312.40.',
      'Forty years and she still plays hard to get.',
      "I'm not opening anything for you, friend.",
      'Step back from the door, friend.',
    ]) expect(claimsUnmadeAction(line), line).toBe(false);
  });
});
