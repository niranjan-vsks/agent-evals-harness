import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compareCodePoints } from '../common/canonical-json';
import { FixtureEntry, sha256Hex } from './hash';

/** Every regular file under root, as POSIX relative path plus content hash. */
export function readFixtureEntries(root: string | null): FixtureEntry[] {
  if (!root || !existsSync(root)) return [];
  const out: FixtureEntry[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out.push({ path: rel, sha256: sha256Hex(readFileSync(full)) });
    }
  };
  walk(root, '');
  return out.sort((a, b) => compareCodePoints(a.path, b.path));
}
