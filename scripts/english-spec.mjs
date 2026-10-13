import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/strings.ts'], bundle: true, write: false, format: 'esm' });
const { TEXT } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
for (const [key, value] of Object.entries(TEXT)) {
  const sample = typeof value === 'function' ? value('SENTINEL_A', 'SENTINEL_B', 'SENTINEL_C', 'SENTINEL_D') : value;
  assert.equal(/[\u3400-\u9fff]/.test(sample), false, `${key} contains untranslated text`);
  if (typeof value === 'function') assert.ok(sample.includes('SENTINEL_A'), `${key} loses its first parameter`);
}
const sourceFiles = [...readdirSync('src').map(f => 'src/' + f), ...readdirSync('scripts').filter(f => /\.(cjs|mjs|json)$/.test(f)).map(f => 'scripts/' + f), 'README.md', 'FORK.md', 'styles.css', 'esbuild.config.mjs', 'manifest.json', 'package.json', 'main.js'];
for (const file of sourceFiles) assert.equal(/[\u3400-\u9fff]/.test(readFileSync(file, 'utf8')), false, `${file} contains untranslated source prose`);
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
assert.equal(manifest.id, 'block-editor-english');
assert.equal(manifest.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
assert.equal(manifest.isDesktopOnly, true);
const dates = await build({ entryPoints: ['src/insert-actions.ts'], bundle: true, write: false, format: 'esm' });
const { formatDateTime } = await import('data:text/javascript;base64,' + Buffer.from(dates.outputFiles[0].text).toString('base64'));
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
for (let i = 0; i < 7; i++) {
  const day = new Date(2026, 9, 4 + i);
  assert.equal(formatDateTime(day, 'dddd'), weekdays[i]);
  assert.equal(formatDateTime(day, 'ddd'), weekdays[i].slice(0, 3));
}
for (const file of ['src/main.ts.bak-colbg', 'src/columns-preview.ts.bak-colbg', 'src/convert.ts.bak-colbg']) assert.equal(/[\u3400-\u9fff]/.test(readFileSync(file, 'utf8')), false);
console.log(`PASS: ${Object.keys(TEXT).length} English strings, interpolation, all source prose, fork identity, seven full and abbreviated weekdays`);
