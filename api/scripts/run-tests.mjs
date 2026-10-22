// Runs the Jest suite against a throwaway database with the migrations applied.
//
// DATABASE_URL set (compose, CI): create `<db>_test` on that server and use it, so the suite
// never touches the live database.
// DATABASE_URL unset (bare host): start an embedded PostgreSQL 16 from the
// `embedded-postgres` dev dependency, which is the same server major as compose.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const EMBEDDED_PORT = Number(process.env.EMBEDDED_PG_PORT ?? 54329);

async function recreateDatabase(adminUrl, name) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  return r.status ?? 1;
}

let embedded = null;
let adminUrl;
let testDb;
let testUrl;

if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  testDb = `${u.pathname.slice(1) || 'postgres'}_test`;
  adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  adminUrl = adminUrl.toString();
  const t = new URL(process.env.DATABASE_URL);
  t.pathname = `/${testDb}`;
  testUrl = t.toString();
} else {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  embedded = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'agent-evals-pg-')),
    user: 'postgres',
    password: 'postgres',
    port: EMBEDDED_PORT,
    persistent: false,
    onLog: () => {},
    onError: (e) => process.stderr.write(String(e) + '\n'),
  });
  await embedded.initialise();
  await embedded.start();
  testDb = 'agent_evals_test';
  adminUrl = `postgresql://postgres:postgres@localhost:${EMBEDDED_PORT}/postgres`;
  testUrl = `postgresql://postgres:postgres@localhost:${EMBEDDED_PORT}/${testDb}`;
}

let status = 1;
try {
  await recreateDatabase(adminUrl, testDb);
  status = run('npx', ['prisma', 'migrate', 'deploy'], { DATABASE_URL: testUrl });
  if (status === 0) {
    // The Prisma 7 client loads its query compiler with a dynamic import(), which Jest's CommonJS
    // sandbox only allows under this Node flag.
    const nodeOptions = [process.env.NODE_OPTIONS, '--experimental-vm-modules', '--no-warnings'].filter(Boolean).join(' ');
    status = run('npx', ['jest', '--runInBand', ...process.argv.slice(2)], { DATABASE_URL: testUrl, NODE_OPTIONS: nodeOptions });
  }
} finally {
  if (embedded) await embedded.stop();
}
process.exit(status);
