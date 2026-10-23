import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TaskFileData } from './task-schema';

/** Grader-only files live here inside a fixture. The worker never copies it into the workspace (R-5, R-7). */
export const HIDDEN_DIR = '_hidden';

const MEMORY_CATEGORIES = new Set(['memory_dependent', 'memory_distractor']);

/**
 * Rules that need more than the shape of one JSON file: they relate the prompt, the graders, the
 * category and the fixture tree. Returns 1 message per problem, without the file name.
 */
export function lintTask(data: TaskFileData, fixtureRoot: string | null): string[] {
  const problems: string[] = [];
  const hidden = (rel: string): boolean => {
    if (fixtureRoot === null) return false;
    const full = join(fixtureRoot, HIDDEN_DIR, rel);
    return existsSync(full) && statSync(full).isFile();
  };

  data.graders.forEach((g, i) => {
    const at = `graders[${i}] (${g.type})`;
    if (g.type === 'exact_match' && !data.prompt.includes('FINAL:')) {
      problems.push(`${at}: the prompt must tell the agent to end with a line "FINAL: <answer>"`);
    }
    if (g.type === 'file_state') {
      for (const c of g.checks) {
        if ('equals_file' in c && !hidden(c.equals_file)) {
          problems.push(`${at}: equals_file "${c.equals_file}" is not a file under ${HIDDEN_DIR}/ of the fixture`);
        }
      }
    }
    if (g.type === 'unit_test') {
      for (const f of g.hidden_files) {
        if (!hidden(f)) problems.push(`${at}: hidden file "${f}" is not a file under ${HIDDEN_DIR}/ of the fixture`);
      }
    }
    if (g.type === 'llm_judge') {
      for (const input of g.inputs) {
        const path = input.startsWith('workspace_file:') ? input.slice('workspace_file:'.length) : null;
        if (path !== null && !data.prompt.includes(path)) {
          problems.push(`${at}: input "${input}" reads a file the prompt never names, so the agent cannot know to write it`);
        }
      }
    }
  });

  if (MEMORY_CATEGORIES.has(data.category)) {
    if (data.memory_fixture === null) problems.push(`category ${data.category} needs a memory_fixture`);
    if (!data.discriminates.includes('memory')) problems.push(`category ${data.category} must list "memory" in discriminates`);
  }
  if (data.prompt.includes(HIDDEN_DIR)) problems.push(`the prompt names ${HIDDEN_DIR}, which only graders may know about`);
  return problems;
}
