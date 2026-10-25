// Display formatting only. Nothing here computes a statistic.

const MINUS = '-';

/** Fixed decimals, ASCII minus, "n/a" for null. A value that rounds to 0 prints as 0 (never "-0.000"). */
export function num(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  const s = v.toFixed(digits);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s.replace('-', MINUS);
}

export const usd = (v: number | null | undefined, digits = 6): string => (v === null || v === undefined ? 'n/a' : `$${num(v, digits)}`);
export const ms = (v: number | null | undefined): string => (v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`);
export const seconds = (v: number | null | undefined): string => (v === null || v === undefined ? 'n/a' : `${(v / 1000).toFixed(1)} s`);
export const int = (v: number | null | undefined): string => (v === null || v === undefined ? 'n/a' : String(Math.round(v)));

export function when(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 10)}...` : id);
export const hashPrefix = (hash: string, n = 8): string => hash.slice(0, n);
