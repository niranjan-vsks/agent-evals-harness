/**
 * Canonical JSON: keys sorted recursively, no whitespace, UTF-8. The one place the platform
 * serializes for hashing (config hash, task hash, fixture hash).
 *
 * Key order is by Unicode code point (UTF-8 byte order), which is what Python's
 * `json.dumps(sort_keys=True)` does. JavaScript's default sort compares UTF-16 code units and
 * disagrees for characters outside the BMP, so it cannot be used here.
 *
 * Numbers use JavaScript's shortest round-trip formatting. Task JSON contains only integers
 * and strings (tasks:lint enforces it), so worker/task_hash.py agrees byte for byte; config
 * settings are hashed only here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${value} is not representable in JSON`);
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort(compareCodePoints);
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k])).join(',') + '}';
    }
    default:
      throw new Error(`canonicalJson: cannot serialize a value of type ${typeof value}`);
  }
}

export function compareCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
