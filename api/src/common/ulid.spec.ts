import { ulid } from './ulid';

describe('ulid', () => {
  it('is 26 chars of the Crockford alphabet', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts by creation time across milliseconds', () => {
    expect(ulid(1_000) < ulid(2_000)).toBe(true);
  });

  it('is strictly increasing within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => ulid(5_000));
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
  });
});
