// CI helper: finds (or creates) the "fileuploader" D1 database and writes its
// id into wrangler.jsonc in the CI checkout. The database id is not a secret.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NAME = 'fileuploader';
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

let db = JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === NAME);
if (!db) {
  console.log(`Creating D1 database ${NAME}`);
  wrangler('d1', 'create', NAME);
  db = JSON.parse(wrangler('d1', 'list', '--json')).find((d) => d.name === NAME);
}
if (!db?.uuid) throw new Error('Could not determine D1 database id');
const cfg = readFileSync('wrangler.jsonc', 'utf8').replace(/"database_id": "[^"]*"/, `"database_id": "${db.uuid}"`);
writeFileSync('wrangler.jsonc', cfg);
console.log(`D1 database ${NAME}: ${db.uuid}`);
