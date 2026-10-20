// Syntax-checks every JavaScript file in the project with the Node ESM parser.
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORE = new Set(['node_modules', '.git', '.vercel']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORE.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

let failed = 0;
const files = walk(root);
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${relative(root, file)}`);
    console.error(String(error.stderr || error.message));
  }
}
console.log(`${files.length} files checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
