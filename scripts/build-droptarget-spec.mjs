/* *
 * Use esbuild to build src/columns-droptarget.ts into ESM .mjs,
 * For columns-droptarget-spec.mjs to assert in pure Node (no Obsidian environment required).
 * This module only relies on @codemirror/state and ./util. It is the only drag and drop logic in this plug-in that does not touch DOM/Obsidian. */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('temp/verify', { recursive: true });

const r = await build({
  entryPoints: ['src/columns-droptarget.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'temp/verify/droptarget.mjs',
  external: ['obsidian'],
});

if (r.errors.length) {
  console.error('build failed:', r.errors);
  process.exit(1);
}
console.log('built temp/verify/droptarget.mjs');

