/* *
 * Mutation test: Deliberately destroy three key logics of planListColumns to confirm that columns-list-spec will fail.
 * If it is still all green after being destroyed, it means that those assertions are always true (equal to no test).
 * Run: node scripts/columns-list-mutation.mjs */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = 'src/convert.ts';
const original = readFileSync(SRC, 'utf8');
mkdirSync('temp/verify', { recursive: true });

/* * Three variations: destroy cut point determination/fence sensing/peeling and indenting respectively */
const MUTATIONS = [
  {
    name: "The cut point judgment is changed to \"indent >= cut layer\" (cut points are too dense)",
    from: 'if (isItem(line) && indentWidth(line) === cutIndent) {',
    to: 'if (isItem(line) && indentWidth(line) >= cutIndent) {',
  },
  {
    name: "Remove fence awareness (fence experts also participate in cut point determination)",
    from: "const f = line.match(/^\\s*(`{3,}|~{3,})/);\n    if (f) {\n      fenceCh = f[1][0];\n      if (cur) cur.push(line);\n      continue;\n    }\n",
    to: '',
  },
  {
    name: "Change indentation stripping to not processing (retain original indentation)",
    from: "return ' '.repeat(Math.max(n - cutIndent, 0)) + l.slice(n);",
    to: 'return l;',
  },
  {
    name: "Put the boot paragraph back into the first column (the regression targeted by this fix)",
    from: "const lead = head.length ? dedent(head.join('\\n')) : '';\n  return lead ? { segments, lead } : { segments };",
    to: "if (head.length) segments[0] = dedent(head.join('\\n')) + '\\n' + segments[0];\n  return { segments };",
  },
];

let escaped = 0;
try {
  for (const [i, m] of MUTATIONS.entries()) {
    if (!original.includes(m.from)) {
      console.log(`SKIP mutation${i + 1}: Target fragment not found (source code has changed?)`);
      escaped++;
      continue;
    }
    writeFileSync(SRC, original.replace(m.from, m.to), 'utf8');
    // Rebuild the product and run assertions
    execFileSync('node', ['scripts/build-convert-spec.mjs'], { stdio: 'pipe' });
    let failed = false;
    let out = '';
    try {
      out = execFileSync('node', ['scripts/columns-list-spec.mjs'], { stdio: 'pipe' }).toString();
    } catch (e) {
      failed = true;
      out = (e.stdout ?? '').toString();
    }
    const summary = (out.match(/\[columns-list\].*/) || ['(\u65e0\u6c47\u603b\u884c)'])[0];
    if (failed) {
      console.log(`PASS variation${i + 1}Caught by assertion →${m.name}`);
      console.log(`        ${summary}`);
    } else {
      console.log(`FAIL mutation${i + 1}It’s all green (assertion is always true!) →${m.name}`);
      console.log(`        ${summary}`);
      escaped++;
    }
  }
} finally {
  writeFileSync(SRC, original, 'utf8');
  execFileSync('node', ['scripts/build-convert-spec.mjs'], { stdio: 'pipe' });
}

console.log(`\n[mutation] ${MUTATIONS.length - escaped}/${MUTATIONS.length}mutants were successfully captured`);
if (escaped) process.exit(1);
