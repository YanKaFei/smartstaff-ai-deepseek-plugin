import { randomBytes, createHash } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}

export function token(): string {
  return randomBytes(32).toString('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic PRNG for reproducible simulation data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  return Number.parseInt(sha256(text).slice(0, 8), 16);
}
