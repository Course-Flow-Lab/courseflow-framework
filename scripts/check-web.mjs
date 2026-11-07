import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const file of ['app.js', 'api.js', 'views.js']) {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../web/${file}`, import.meta.url))], { stdio: 'inherit' });
}
console.log('Web JavaScript syntax OK');
