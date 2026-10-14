import { describe, expect, it } from 'vitest';
import { Bank, DEFAULT_CUSTOMER, RESERVED_ACCOUNTS } from '../src/bank/world.js';
import { customerFor } from '../src/game/engine.js';

describe('each player is their own customer', () => {
  it('gives the player the name they chose and an account of their own', () => {
    const c = customerFor('  Ada   Lovelace ');
    expect(c.name).toBe('Ada Lovelace');
    expect(c.account).toMatch(/^\d{4}$/);
    expect(RESERVED_ACCOUNTS).not.toContain(c.account);
    // Different players get different accounts.
    expect(customerFor('Ada', () => 0.1).account).not.toBe(customerFor('Ada', () => 0.9).account);
  });

  it('falls back to the default customer when no usable name was given', () => {
    for (const name of [undefined, '', '   ', '<script>', '1234']) expect(customerFor(name)).toEqual(DEFAULT_CUSTOMER);
  });

  it("opens the bank with the player's account, note and place on the list", () => {
    const bank = new Bank({ name: 'Ada Lovelace', account: '5832' });
    expect(bank.checkBalance('5832')).toMatchObject({ owner: 'Ada Lovelace' });
    expect(() => bank.checkBalance('4471')).toThrow();
    expect(bank.readDocument('note').text).toContain('5832');
    expect(bank.checkVisitorList('Ada Lovelace').expected).toBe(true);
    expect(bank.checkVisitorList('ada').expected).toBe(true);
    expect(bank.checkVisitorList('Dana Whitlock').expected).toBe(false);
    expect(bank.checkVisitorList('Ada Byron').expected).toBe(false);
    // A reset keeps the same customer.
    bank.reset();
    expect(bank.checkBalance('5832')).toMatchObject({ owner: 'Ada Lovelace' });
  });
});
