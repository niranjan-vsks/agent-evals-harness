import { randomBytes } from 'node:crypto';

// Crockford base32, the ULID alphabet. Ids are 26 chars: 10 of time, 16 of randomness.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_RANDOM = (1n << 80n) - 1n;

let lastTime = -1;
let lastRandom = 0n;

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function freshRandom(): bigint {
  return BigInt('0x' + randomBytes(10).toString('hex'));
}

/**
 * Monotonic within a millisecond: a second call in the same ms increments the random part,
 * so ids from one process sort in creation order.
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime && lastRandom < MAX_RANDOM) {
    lastRandom += 1n;
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encode(BigInt(now), 10) + encode(lastRandom, 16);
}
