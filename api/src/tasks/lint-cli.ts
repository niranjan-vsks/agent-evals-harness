import { defaultTasksDir, loadTasks } from './load-tasks';

const dir = defaultTasksDir();
const { tasks, memoryFixtures, errors } = loadTasks(dir);
if (errors.length) {
  for (const e of errors) console.error(`tasks:lint: ${e}`);
  console.error(`tasks:lint: ${errors.length} problem(s) in ${dir}`);
  process.exit(1);
}
console.log(`tasks:lint: ${tasks.length} task(s) and ${memoryFixtures.length} memory fixture(s) OK in ${dir}`);
