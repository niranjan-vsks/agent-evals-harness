/**
 * A small RFC 4180 reader for the export specs: the reverse of src/export/csv.ts, written independently so a round trip
 * through both proves the writer. Quoted fields may contain commas, doubled quotes, CR and LF. Records end at LF or CRLF.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRecord();
    else if (c === '\r' && text[i + 1] === '\n') {
      endRecord();
      i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || record.length > 0) endRecord(); // a last record without a line end
  return records;
}

/** Header-keyed rows of a parsed CSV. */
export function csvObjects(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
