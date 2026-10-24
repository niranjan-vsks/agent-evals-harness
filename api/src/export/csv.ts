/**
 * A small RFC 4180 writer for the exports (DATA_MODEL 5). Pure.
 *
 * - A field is quoted when it contains a comma, a double quote, CR or LF; inside quotes each `"` is doubled.
 * - Records end with `\n` (the last one too); the header is the first record.
 * - null and undefined are empty fields; numbers are plain decimals (never `1e-7`); booleans are `true` / `false`.
 *
 * Formula injection: a text field that starts with `=`, `+`, `-`, `@`, a tab or a CR can be run as a formula by a spreadsheet that
 * opens the file. Such STRING values get a single leading apostrophe (the spreadsheet convention for "this is text"), so a config
 * name like `=HYPERLINK(...)` is neutralised. Numbers and booleans are never prefixed: a delta of -0.25 is a number and stays
 * `-0.25`. The apostrophe is part of the stored text of the field, so a reader that wants the original strips 1 leading `'` from a
 * field that starts with `'` followed by one of those characters.
 */
export type CsvValue = string | number | boolean | null | undefined;

const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** A finite number as a plain decimal. Non-finite numbers have no CSV form and become an empty field. */
export function plainNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Object.is(n, -0)) return '0';
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // 1e-7 and 1e21 print with an exponent in JS; Intl never does. 20 fraction digits cover every double the API emits.
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return plainNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const text = FORMULA_START.test(v) ? `'${v}` : v;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRecord(values: readonly CsvValue[]): string {
  return `${values.map(csvField).join(',')}\n`;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  return csvRecord(header) + rows.map(csvRecord).join('');
}
