/* *
 * Use esbuild to build src/handle-layout.ts into ESM .mjs,
 * For handle-layout-spec.mjs to assert in pure Node (no Obsidian/DOM required). */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('temp/verify', { recursive: true });

const r = await build({
  entryPoints: ['src/handle-layout.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'temp/verify/handle-layout.mjs',
  external: ['obsidian'],
});

if (r.errors.length) {
  console.error('build failed:', r.errors);
  process.exit(1);
}
console.log('built temp/verify/handle-layout.mjs');
