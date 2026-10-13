import { spawnSync } from 'node:child_process';
const names = ['test:columns', 'test:cmview', 'test:handle', 'test:slash', 'test:insert', 'test:extract', 'test:columns-list', 'test:columns-list:mutation', 'test:list-number', 'test:english'];
let failed = 0;
for (const name of names) {
  const result = spawnSync('npm', ['run', name], { encoding: 'utf8' });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}`);
  if (result.status !== 0) { failed++; process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); }
}
console.log(`${names.length - failed}/${names.length} suites passed`);
process.exitCode = failed ? 1 : 0;
