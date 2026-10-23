import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { judgeValidationDir, SAMPLE_FILE } from './paths';
import { loadCandidates, stratifiedDraw, writeSample } from './sample';
import { PrismaService } from '../prisma/prisma.service';

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const n = Number(a.n ?? 30);
  const seed = Number(a.seed ?? 20261023);
  if (!Number.isInteger(n) || n < 1) throw new Error('--n must be a positive integer');
  const out = a.out ? resolve(a.out) : resolve(judgeValidationDir(), SAMPLE_FILE);

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const { candidates, skipped } = await loadCandidates(prisma, { experimentId: a.experiment, includeAdhoc: 'include-adhoc' in a });
    const draw = stratifiedDraw(candidates, n, seed);
    if (draw.chosen.length === 0) {
      console.error(`judge:sample: no judge-graded trials to draw from${'include-adhoc' in a ? '' : ' (ad hoc trials are left out; pass --include-adhoc)'}; nothing written`);
      process.exit(1);
    }
    if (existsSync(out) && !('force' in a)) {
      console.error(`judge:sample: ${out} exists and may be mid-labelling; pass --force to replace it`);
      process.exit(1);
    }
    writeSample(out, draw.chosen);
    console.log(`judge:sample wrote ${draw.chosen.length} of ${n} requested items to ${out} (seed ${seed})`);
    console.log(`  candidates: ${candidates.length}${skipped ? `, skipped ${skipped} judge result(s) that did not record what the judge saw` : ''}`);
    for (const [cell, count] of Object.entries(draw.perCell).sort()) console.log(`  ${cell.replace('|', '  config ')}: ${count}`);
    if (draw.short) console.log('  WARNING: fewer candidates than requested; run more judge-graded trials');
    console.log('  the file has no passed, reasoning or criteria fields and no config (D-15)');
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(`judge:sample: ${(e as Error).message}`);
  process.exit(1);
});
