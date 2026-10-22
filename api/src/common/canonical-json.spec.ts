import { canonicalJson } from './canonical-json';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('orders keys by code point, not by UTF-16 code unit', () => {
    // U+FF5E is 1 UTF-16 unit above the surrogate range; U+1F600 is a surrogate pair below it.
    // Code point order puts U+FF5E first. A plain Array.sort() would put U+1F600 first.
    const keys = Object.keys(JSON.parse(canonicalJson({ '\u{1F600}': 1, '～': 2 })));
    expect(keys).toEqual(['～', '\u{1F600}']);
  });

  it('keeps non-ASCII text as is and escapes control characters', () => {
    expect(canonicalJson('café 日本 \n\t\u0001')).toBe('"café 日本 \\n\\t\\u0001"');
  });

  it('serializes null, booleans, empty containers and numbers', () => {
    expect(canonicalJson({ a: null, b: true, c: [], d: {}, e: 0, f: -7, g: 0.5 })).toBe(
      '{"a":null,"b":true,"c":[],"d":{},"e":0,"f":-7,"g":0.5}',
    );
  });

  it('omits undefined object values like JSON.stringify and nulls them in arrays', () => {
    expect(canonicalJson({ a: undefined, b: 1, c: [undefined] })).toBe('{"b":1,"c":[null]}');
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
});
