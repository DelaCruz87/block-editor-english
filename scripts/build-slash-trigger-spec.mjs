/* *
 * Use esbuild to build src/slash-trigger.ts into ESM .mjs,
 * For slash-trigger-spec.mjs to assert in pure Node (no Obsidian environment required). */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('temp/verify', { recursive: true });

const r = await build({
  entryPoints: ['src/slash-trigger.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'temp/verify/slash-trigger.mjs',
  external: ['obsidian'],
});

if (r.errors.length) {
  console.error('build failed:', r.errors);
  process.exit(1);
}
console.log('built temp/verify/slash-trigger.mjs');
