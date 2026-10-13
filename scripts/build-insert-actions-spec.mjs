/* *
 * Type the pure logic module into ESM .mjs for insert-actions-spec.mjs to assert in pure Node.
 * None of insert-actions.ts / constants.ts depends on the obsidian runtime (only type import). */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('temp/verify', { recursive: true });

const r = await build({
  entryPoints: ['src/insert-actions.ts', 'src/constants.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outdir: 'temp/verify',
  outExtension: { '.js': '.mjs' },
  external: ['obsidian'],
});

if (r.errors.length) {
  console.error('build failed:', r.errors);
  process.exit(1);
}
console.log('built temp/verify/insert-actions.mjs, constants.mjs');
