import { createHash } from 'node:crypto';
import { canonicalJson, compareCodePoints } from '../common/canonical-json';

/**
 * Pure. Must agree byte for byte with worker/task_hash.py (asserted on tasks/_hashvector by
 * both test suites).
 *
 * sha256( canonical(task JSON minus "version_hash") + "\n"
 *         + for each fixture file sorted by POSIX relative path: path + "\0" + sha256hex(bytes) + "\n" )
 */
export interface FixtureEntry {
  /** POSIX path relative to the fixture root. */
  path: string;
  sha256: string;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sorted(entries: FixtureEntry[]): FixtureEntry[] {
  return [...entries].sort((a, b) => compareCodePoints(a.path, b.path));
}

function updateWithEntries(h: ReturnType<typeof createHash>, entries: FixtureEntry[]): void {
  for (const e of sorted(entries)) h.update(`${e.path}\0${e.sha256}\n`, 'utf8');
}

export function taskHash(task: Record<string, unknown>, fixture: FixtureEntry[]): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { version_hash: _ignored, ...body } = task;
  const h = createHash('sha256');
  h.update(canonicalJson(body), 'utf8');
  h.update('\n', 'utf8');
  updateWithEntries(h, fixture);
  return h.digest('hex');
}

/** Memory fixture identity (DATA_MODEL 2.3): sha256 of the sorted (filename, bytes) pairs. */
export function memoryFixtureHash(files: Record<string, string | Buffer>): string {
  const h = createHash('sha256');
  updateWithEntries(
    h,
    Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes) })),
  );
  return h.digest('hex');
}
