/* * For spec reuse: list-number.ts is pure logic and can be directly typed into mjs by esbuild */
import { build } from 'esbuild';

const r = await build({
  entryPoints: ['src/list-number.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'temp/verify/list-number.mjs',
});
if (r.errors.length) {
  console.error(r.errors);
  process.exit(1);
}
console.log('built temp/verify/list-number.mjs');
