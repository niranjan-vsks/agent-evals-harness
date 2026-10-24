import { csvObjects, parseCsv } from '../../test/csv-parse';
import { csvField, csvRecord, plainNumber, toCsv } from './csv';

describe('csv writer (RFC 4180)', () => {
  it('leaves plain fields unquoted and ends every record with \\n', () => {
    expect(csvRecord(['a', 'b c', 'd'])).toBe('a,b c,d\n');
    expect(toCsv(['x', 'y'], [['1', '2'], ['3', '4']])).toBe('x,y\n1,2\n3,4\n');
    expect(toCsv(['x'], [])).toBe('x\n');
  });

  it.each([
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line1\nline2', '"line1\nline2"'],
    ['line1\r\nline2', '"line1\r\nline2"'],
    ['cr\ronly', '"cr\ronly"'],
    ['"', '""""'],
    ['', ''],
    [' padded ', ' padded '],
  ])('quotes a field only when it must: %j', (input, expected) => {
    expect(csvField(input)).toBe(expected);
  });

  it('writes null and undefined as empty, booleans as true/false', () => {
    expect(csvRecord([null, undefined, true, false, '', 0])).toBe(',,true,false,,0\n');
  });

  it('writes numbers as plain decimals, never with an exponent', () => {
    expect(plainNumber(1)).toBe('1');
    expect(plainNumber(-0.25)).toBe('-0.25');
    expect(plainNumber(0.0000576)).toBe('0.0000576');
    expect(plainNumber(1e-7)).toBe('0.0000001');
    expect(plainNumber(1.5e-10)).toBe('0.00000000015');
    expect(plainNumber(1e21)).toBe('1000000000000000000000');
    expect(plainNumber(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(plainNumber(-0)).toBe('0');
    expect(csvField(1e-7)).toBe('0.0000001');
  });

  it('writes a non-finite number as an empty field', () => {
    expect(csvRecord([NaN, Infinity, -Infinity])).toBe(',,\n');
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['+1', "'+1"],
    ['-2+3', "'-2+3"],
    ['-0.25', "'-0.25"],
    ['\tx', "'\tx"],
    ['=HYPERLINK("http://x","y")', '"\'=HYPERLINK(""http://x"",""y"")"'],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ['\rcr', '"\'\rcr"'],
  ])('prefixes 1 apostrophe on a string that starts with = + - @ tab or CR: %j', (input, expected) => {
    expect(csvField(input)).toBe(expected);
  });

  it('prefixes once, only at the start, and only strings: numbers, booleans and ordinary text are untouched', () => {
    expect(csvField("'=1+1")).toBe("'=1+1"); // already starts with an apostrophe: not a formula start, so no second one
    expect(csvField('a=b')).toBe('a=b');
    expect(csvField('x-y')).toBe('x-y');
    expect(csvField('user@host')).toBe('user@host');
    expect(csvField(' =1')).toBe(' =1');
    expect(csvField(-0.25)).toBe('-0.25');
    expect(csvField(-3)).toBe('-3');
    expect(csvField(true)).toBe('true');
    expect(csvField('')).toBe('');
    expect(csvRecord([-0.25, '-0.25', '=x'])).toBe("-0.25,'-0.25,'=x\n");
  });

  it('round-trips awkward fields through an independent reader', () => {
    const awkward = ['plain', 'a,b', 'say "hi"', 'two\nlines', 'crlf\r\nhere', '"', '""', ',', '', "'=1+1", ' lead and trail ', 'ünïcode ✓', ',"\n"'];
    const text = toCsv(['c1', 'c2', 'c3'], [
      [awkward[0], awkward[1], awkward[2]],
      [awkward[3], awkward[4], awkward[5]],
      [awkward[6], awkward[7], awkward[8]],
      [awkward[9], awkward[10], awkward[11]],
      [awkward[12], null, 7],
    ]);
    const back = parseCsv(text);
    expect(back[0]).toEqual(['c1', 'c2', 'c3']);
    expect(back.slice(1).flat().slice(0, 12)).toEqual(awkward.slice(0, 12));
    expect(back[5]).toEqual([awkward[12], '', '7']);
    expect(back).toHaveLength(6);
  });

  it('a neutralised formula parses back with its apostrophe, and a negative number parses back unchanged', () => {
    const back = parseCsv(toCsv(['name', 'delta'], [['=HYPERLINK("x")', -0.25]]));
    expect(back[1]).toEqual(['\'=HYPERLINK("x")', '-0.25']);
  });

  it('parses CRLF line ends and a last record without a line end (reader sanity)', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
    expect(csvObjects('a,b\n1,"x,y"\n')).toEqual([{ a: '1', b: 'x,y' }]);
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });
});
