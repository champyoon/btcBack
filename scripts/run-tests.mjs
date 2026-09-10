import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(join(root, 'tests'))
  .filter(file => /\.test\.(?:cjs|mjs)$/.test(file))
  .sort()
  .map(file => join(root, 'tests', file));
if (!files.length) throw new Error('No test files found');

// Explicit paths avoid shell-dependent glob expansion; bound browser/WASM load.
console.log(`Running all ${files.length} test files`);
const result = spawnSync(process.execPath,
  ['--test', '--test-concurrency=2', ...files],
  { cwd: root, stdio: 'inherit', shell: false });
if (result.error) console.error('Could not start the Node test runner:', result.error.message);
process.exitCode = result.status ?? 1;
