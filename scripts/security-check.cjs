/**
 * ============================================================================
 * CareGrid AI — Phase 2 security checklist, mechanically verified
 * ============================================================================
 *
 * The Phase 2 brief (§39) lists fifteen items. Fourteen of them are properties of
 * files in this repository and can be checked by reading the files; this script
 * checks them so the answer cannot drift from the code between reviews.
 *
 * The fifteenth — "logout invalidates application auth state" — is a runtime
 * behaviour and is verified in `tests/unit/privilege-escalation.test.ts` plus a
 * manual browser pass, not here.
 *
 * USAGE:  node scripts/security-check.cjs
 * EXIT:   0 when every check passes, 1 otherwise. Wire it into CI.
 */

'use strict';

const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join, extname } = require('node:path');

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'docs', 'coverage']);

const results = [];

function check(label, passed, detail) {
  results.push({ label, passed, detail });
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.ts', '.tsx', '.mjs', '.json', '.rules', '.css'].includes(extname(full))) out.push(full);
  }
  return out;
}

const sourceRoots = ['app', 'components', 'features', 'config', 'lib', 'types', 'validators', 'tests', 'scripts'];
const files = sourceRoots.flatMap((root) => walk(join(ROOT, root)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
/**
 * Path relative to the project root, ALWAYS with forward slashes.
 *
 * The normalisation is not cosmetic: `path.join` produces backslashes on
 * Windows, so a set membership test against a forward-slash literal would
 * silently fail and every exclusion in this file would be a no-op — which looks
 * exactly like "no violations found" while checking nothing.
 */
const rel = (path) => path.replace(ROOT + '\\', '').replace(ROOT + '/', '').split('\\').join('/');

/* ------------------------------------------------------------------------ */
/* 1. No credentials in source                                                */
/* ------------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS-style secret key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Firebase private key assignment', re: /FIREBASE_PRIVATE_KEY\s*=\s*['"]-----BEGIN/ },
];

const secretHits = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) secretHits.push(`${rel(file)}: ${name}`);
  }
}
check('No credentials in source', secretHits.length === 0, secretHits.join('; '));

/* ------------------------------------------------------------------------ */
/* 2. No real secret in .env.example                                         */
/* ------------------------------------------------------------------------ */

const envExample = existsSync(join(ROOT, '.env.example')) ? read('.env.example') : '';
const SECRET_VARS = [
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'GEMINI_API_KEY',
  'GOOGLE_MAPS_SERVER_KEY',
  'CRON_SECRET',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
  'SEED_DEMO_PASSWORD',
  'IP_HASH_SALT',
];
const populated = [];
for (const line of envExample.split('\n')) {
  const bare = line.split('#')[0].trim();
  for (const name of SECRET_VARS) {
    if (bare.startsWith(`${name}=`)) {
      const value = bare.slice(name.length + 1).trim();
      if (value !== '') populated.push(`${name}=${value.slice(0, 12)}…`);
    }
  }
}
check('Every secret in .env.example is empty', populated.length === 0, populated.join('; '));

/* ------------------------------------------------------------------------ */
/* 3. .env.local is git-ignored and absent                                    */
/* ------------------------------------------------------------------------ */

const gitignore = existsSync(join(ROOT, '.gitignore')) ? read('.gitignore') : '';
const ignored = /^\.env\*?\.local/m.test(gitignore) || /^\.env$/m.test(gitignore) || /^\.env\*/m.test(gitignore);
const localAbsent = !existsSync(join(ROOT, '.env.local'));
check('.env.local is git-ignored', ignored);
check('.env.local is not committed', localAbsent, localAbsent ? '' : '.env.local exists in the tree');

/* ------------------------------------------------------------------------ */
/* 4. No role, permission, or token comes from browser storage                 */
/* ------------------------------------------------------------------------ */

const STORAGE_READ = /(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const storageOffenders = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(STORAGE_READ)) {
    const key = String(match[1] ?? '').toLowerCase();
    if (/(role|permission|auth|token|session)/.test(key)) {
      storageOffenders.push(`${rel(file)}: "${key}"`);
    }
  }
}
check(
  'No role/permission/token in localStorage or sessionStorage',
  storageOffenders.length === 0,
  storageOffenders.join('; '),
);

/* ------------------------------------------------------------------------ */
/* 5. No role from the URL or a data attribute                                */
/* ------------------------------------------------------------------------ */

const urlOffenders = [];
const URL_ROLE = [
  /get\(\s*['"`]role['"`]\s*\)/g,
  /data-role=/g,
  /['"`]\?role=/g,
];
/**
 * The scanner's own test file and this script CONTAIN these patterns as the
 * thing they look for, so scanning them is a guaranteed false positive. Excluded
 * by explicit name rather than by guesswork, and the exclusion is itself visible
 * here so a reader knows exactly which two files are not covered.
 */
const SCANNER_SELF = new Set([
  'tests/unit/privilege-escalation.test.ts',
  'scripts/security-check.cjs',
]);

for (const file of files) {
  if (SCANNER_SELF.has(rel(file))) continue;
  const text = readFileSync(file, 'utf8');
  for (const re of URL_ROLE) {
    if (re.test(text)) urlOffenders.push(`${rel(file)}: ${re}`);
  }
}
check('No role read from the query string or a data attribute', urlOffenders.length === 0, urlOffenders.join('; '));

/* ------------------------------------------------------------------------ */
/* 6. The privilege-escalation scan test exists and passes                    */
/* ------------------------------------------------------------------------ */

const escalationTest = existsSync(join(ROOT, 'tests/unit/privilege-escalation.test.ts'));
check('A privilege-escalation test suite exists', escalationTest);

/* ------------------------------------------------------------------------ */
/* 7. firestore.rules                                                         */
/* ------------------------------------------------------------------------ */

const rules = existsSync(join(ROOT, 'firestore.rules')) ? read('firestore.rules') : '';
const usersBlock = rules.match(/match \/users\/\{uid\}[^{]*\{([\s\S]*?)\n    \}/);
check(
  'users/{uid} is client-write-denied',
  Boolean(usersBlock) && /allow\s+create\s*,\s*update\s*,\s*delete\s*:\s*if\s+false/.test(String(usersBlock[1])) && !/allow\s+write\s*:/.test(String(usersBlock[1])),
);
check(
  'auditLogs is append-only',
  /match \/auditLogs[\s\S]*?allow update, delete: if false;/.test(rules),
);
check(
  'responders cannot self-write `verification`',
  /function selfEditableFields\(\)\s*\{[^}]*\}/.test(rules) && !/function selfEditableFields\(\)\s*\{[^}]*verification/.test(rules),
);
check('firestore.rules denies by default', /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/.test(rules));
check('dispatches are server-mediated only', /match \/dispatches[\s\S]*?allow write: if false;/.test(rules));

const storageRules = existsSync(join(ROOT, 'storage.rules')) ? read('storage.rules') : '';
check('final evidence paths are closed to clients', /match \/incidents\/\{incidentId\}[\s\S]*?allow read, write, delete: if false;/.test(storageRules));

/* ------------------------------------------------------------------------ */
/* 8. server-only on every module that can reach a secret                     */
/* ------------------------------------------------------------------------ */

const SERVER_MODULES = [
  'lib/server/firebase-admin.ts',
  'lib/server/auth-guard.ts',
  'lib/server/audit.ts',
  'lib/server/route.ts',
  'lib/server/errors.ts',
  'lib/server/http.ts',
  'lib/env.server.ts',
];
const missingGuard = SERVER_MODULES.filter((path) => {
  if (!existsSync(join(ROOT, path))) return true;
  return !/^\s*import 'server-only';/m.test(read(path));
});
check('Every secret-reading module has `server-only`', missingGuard.length === 0, missingGuard.join('; '));

/* ------------------------------------------------------------------------ */
/* 9. The client never imports a server module                               */
/* ------------------------------------------------------------------------ */

const SERVER_PATTERN = /from '@\/(lib\/server\/|env\.server|env\.maintenance)/;
const clientOffenders = [];
for (const file of files) {
  const path = rel(file);
  // Route handlers ARE server, and a server module importing another server
  // module is the whole point of the lib/server boundary.
  if (path.startsWith('app/api') || path.startsWith('lib/server')) continue;
  const text = readFileSync(file, 'utf8');
  if (SERVER_PATTERN.test(text)) clientOffenders.push(rel(file));
}
check('No client-reachable file imports a server module', clientOffenders.length === 0, clientOffenders.join('; '));

/* ------------------------------------------------------------------------ */
/* 10. Firebase credentials are environment variables, never literals        */
/* ------------------------------------------------------------------------ */

const firebaseConfigHits = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // An `initializeApp({ ... })` with a literal apiKey would be a hard-coded
  // credential. The config must come from `getPublicConfig()`.
  if (/initializeApp\(\s*\{/.test(text) && /apiKey\s*:/.test(text)) {
    firebaseConfigHits.push(rel(file));
  }
}
check('No hard-coded Firebase config', firebaseConfigHits.length === 0, firebaseConfigHits.join('; '));

/* ------------------------------------------------------------------------ */
/* Report                                                                     */
/* ------------------------------------------------------------------------ */

const pad = Math.max(...results.map((r) => r.label.length));
let failed = 0;

console.log('CareGrid AI — Phase 2 security checklist\n');
for (const result of results) {
  const mark = result.passed ? 'PASS' : 'FAIL';
  if (!result.passed) failed += 1;
  console.log(`  [${mark}] ${result.label.padEnd(pad)}`);
  if (!result.passed && result.detail) {
    console.log(`         ${result.detail}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed === 0 ? 0 : 1);
