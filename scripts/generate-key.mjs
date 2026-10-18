// Generates a random 32-byte TOKEN_ENCRYPTION_KEY and pipes it straight into
// `wrangler secret put`, so the value is never printed or saved to disk.
//   node scripts/generate-key.mjs            -> sets TOKEN_ENCRYPTION_KEY
//   node scripts/generate-key.mjs --print    -> prints a key (for .dev.vars only)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64url');
if (process.argv.includes('--print')) {
  console.log(key);
} else {
  const name = process.argv.find((a) => a.startsWith('--name='))?.slice(7) ?? 'TOKEN_ENCRYPTION_KEY';
  const child = spawn('npx', ['wrangler', 'secret', 'put', name], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(key);
  child.on('exit', (code) => process.exit(code ?? 1));
}
