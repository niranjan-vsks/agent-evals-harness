import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { runKappa, parseLabels } from './kappa';
import { judgeValidationDir, LABELS_FILE } from './paths';

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const path = a.labels ? resolve(a.labels) : resolve(judgeValidationDir(), LABELS_FILE);
  if (!existsSync(path)) throw new Error(`${path} does not exist; label the items of sample.jsonl first`);
  const labels = parseLabels(readFileSync(path, 'utf8'));

  const prisma = new PrismaService();
  await prisma.$connect();
  let failed = false;
  try {
    const runs = await runKappa(prisma, labels, { labeler: a.labeler, minItems: a['min-items'] === undefined ? undefined : Number(a['min-items']) });
    for (const r of runs) {
      console.log(`judge ${r.judgeModelId}  prompt ${r.judgePromptHash.slice(0, 12)}  labeler ${r.labeler}`);
      if (!r.outcome.ok) {
        failed = true;
        console.log(`  NOT VALIDATED: ${r.outcome.reason}`);
        continue;
      }
      const v = r.outcome.validation;
      console.log(`  items ${v.nItems}  agreement ${v.agreementRaw}  kappa ${v.kappa}  95% CI [${v.kappaCiLow}, ${v.kappaCiHigh}]  policy ${v.policy}`);
      if (v.usedResamples < 0.95 * 10000) console.log(`  WARNING: only ${v.usedResamples} of 10000 resamples had a defined kappa; the interval is conditional on both raters showing variance`);
      console.log(`  judge_validation ${r.validationId} written`);
    }
  } finally {
    await prisma.$disconnect();
  }
  if (failed) process.exitCode = 1;
}
main().catch((e) => {
  console.error(`judge:kappa: ${(e as Error).message}`);
  process.exit(1);
});
