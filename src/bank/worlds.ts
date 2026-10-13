import { Bank } from './world.js';

/**
 * One bank per game. Each MCP request names its game in a header, so two players never see each
 * other's doors or balances. Worlds idle for too long, or beyond the cap, are dropped oldest first.
 */
export class Worlds {
  private readonly banks = new Map<string, { bank: Bank; touched: number }>();

  constructor(
    private readonly max = 50,
    private readonly idleMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): Bank {
    const t = this.now();
    for (const [key, w] of this.banks) if (t - w.touched > this.idleMs) this.banks.delete(key);
    let w = this.banks.get(id);
    if (!w) {
      if (this.banks.size >= this.max) {
        const oldest = [...this.banks.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
        if (oldest) this.banks.delete(oldest[0]);
      }
      w = { bank: new Bank(), touched: t };
      this.banks.set(id, w);
    }
    w.touched = t;
    return w.bank;
  }

  drop(id: string): void {
    this.banks.delete(id);
  }

  get size(): number {
    return this.banks.size;
  }
}

export const DEFAULT_WORLD = 'default';
export const WORLD_HEADER = 'x-game-id';

/** A header value is only trusted as a map key, and only if it looks like one. */
export function worldId(header: string | undefined): string {
  return header && /^[\w-]{1,64}$/.test(header) ? header : DEFAULT_WORLD;
}
