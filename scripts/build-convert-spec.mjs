/* * Extract buildColumnsMarkdown for reuse by e2e suite (pure string logic; obsidian only has type but no runtime, stubbing is required) */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync('temp/verify', { recursive: true });

// The top of convert.ts imports obsidian (Notice, etc.), but buildColumnsMarkdown is pure string logic,
// Here is the minimum stub, allowing esbuild to be inlined into the product, without the need for real Obsidian at runtime.
const stubPath = resolve('temp/verify/obsidian-stub.mjs');
writeFileSync(stubPath, 'export class Notice { constructor(){} }\nexport function setIcon(){}\n');

const r = await build({
  entryPoints: ['src/convert.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'temp/verify/convert.mjs',
  plugins: [
    {
      name: 'stub-obsidian',
      setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: stubPath }));
      },
    },
  ],
});
if (r.errors.length) { console.error(r.errors); process.exit(1); }
console.log('built temp/verify/convert.mjs');
