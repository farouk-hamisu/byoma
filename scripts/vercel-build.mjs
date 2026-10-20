// Vercel build step: copy the static site into dist/ so the deploy works no
// matter whether Output Directory is left blank (serves repo root) or set to
// "dist" (a common default that would otherwise ship only the function bundles).
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');

// Site files/folders that must be in the deployed output.
const SITE_ENTRIES = [
  'index.html',
  'apply.html',
  'confirmation.html',
  'privacy.html',
  'env.js',
  'css',
  'js',
  'assets',
  'admin',
];

mkdirSync(out, { recursive: true });

let copied = 0;
for (const entry of SITE_ENTRIES) {
  const src = resolve(root, entry);
  if (!existsSync(src)) {
    console.error(`vercel-build: missing required entry "${entry}"`);
    process.exit(1);
  }
  cpSync(src, resolve(out, entry), { recursive: true });
  copied += 1;
}

console.log(`vercel-build: copied ${copied} site entries into dist/`);
console.log('dist contents:', readdirSync(out).join(', '));
