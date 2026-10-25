import { PrismaService } from '../prisma/prisma.service';
import { backfill, formatReport } from './backfill';

/** npm run failures:backfill -- [--experiment <id>] [--dry-run] [--sample <n per category>] [--seed <n>] */
function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const sample = a.sample === undefined ? 0 : Number(a.sample === '' ? 5 : a.sample);
  if (!Number.isInteger(sample) || sample < 0) throw new Error('--sample must be a non-negative integer');
  const seed = a.seed === undefined ? undefined : Number(a.seed);
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error('--seed must be an integer');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await backfill(prisma, { experimentId: a.experiment || undefined, dryRun: 'dry-run' in a, sample, seed });
    console.log(formatReport(report));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`failures:backfill: ${(e as Error).message}`);
  process.exit(1);
});
