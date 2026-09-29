/**
 * ============================================================================
 * CareGrid AI — security checklist, mechanically verified
 * ============================================================================
 *
 * Every item below is a property of files in this repository and is checked by
 * reading them, so the answer cannot drift from the code between reviews. Three
 * of them need a running server and are verified by the unit suite and by a
 * manual pass instead; they say so.
 *
 * PHASE 3 added: the `NEXT_PUBLIC_`-publishes-a-secret check, the credential-file
 * ignore rules, the "one reader per secret" rule, the "no fake API key" rule, and
 * the `server-only` guard on all six new server modules.
 *
 * USAGE:  node scripts/security-check.cjs
 * EXIT:   0 when every check passes, 1 otherwise. Wired into `npm run verify`.
 */

'use strict';

const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join, extname } = require('node:path');
// Phase 4 audit. Used ONLY by the `.gitignore` coverage check, which asks git to
// resolve the patterns rather than reimplementing gitignore semantics — a
// hand-rolled matcher eventually disagrees with git, and a security check that
// disagrees with git is worse than none.
const { execFileSync } = require('node:child_process');

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

const sourceRoots = ['app', 'components', 'features', 'config', 'lib', 'types', 'validators', 'tests', 'scripts', 'services'];
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

/**
 * Strip comments, respecting string literals.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A REGEX
 * ---------------------------------------------------------------------------
 * Because a regex gets this wrong in a way that produces a SILENT false pass, and
 * this file hit it while being written.
 *
 * `middleware.ts` contains the CSP directive that lists the Firestore realtime
 * transport as `wss:` followed by two slashes and an asterisk. In that string,
 * the two-character sequence "slash asterisk" appears. A block-comment strip
 * written as a pattern therefore treats it as the start of a comment and
 * swallows every directive from there to the next closing marker — several
 * hundred characters of real configuration — so every check below it reports
 * "not found" and the whole security check passes while reading nothing.
 *
 * A checker that silently stops seeing code is worse than no checker. So this is
 * a small explicit scanner with four states rather than a pattern.
 *
 * Its one known limitation: a REGEX LITERAL containing a quote character would be
 * mis-parsed as a string. No file checked here contains one, and the limitation is
 * stated rather than defended against with more scanner code.
 *
 * (Note that this very comment had to be reworded: its first draft quoted the
 * pattern it was warning about, and the quoted pattern closed the comment.)
 */

function code(path) {
  const text = readFileSync(join(ROOT, path), 'utf8');
  const SINGLE = 39;
  const DOUBLE = 34;
  const BACKTICK = 96;
  const BACKSLASH = 92;
  const SLASH = 47;
  const STAR = 42;
  const NEWLINE = 10;

  let out = '';
  let i = 0;
  // 'code' | 'line' | 'block' | a quote character
  let mode = 'code';

  while (i < text.length) {
    const ch = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);

    if (mode === 'code') {
      if (ch === SLASH && next === SLASH) { mode = 'line'; i += 2; continue; }
      if (ch === SLASH && next === STAR) { mode = 'block'; i += 2; continue; }
      if (ch === SINGLE || ch === DOUBLE || ch === BACKTICK) {
        mode = String.fromCharCode(ch);
        out += text[i];
        i += 1;
        continue;
      }
      out += text[i];
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (ch === NEWLINE) { mode = 'code'; out += text[i]; }
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (ch === STAR && next === SLASH) { mode = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    // Inside a string literal. A backslash escapes the next character.
    //
    // The CONTENT IS KEPT, not discarded, and that is deliberate: several checks
    // below look for a name that only ever appears inside a string literal —
    // a variable name, a CSP directive, an error code. A stripper that deleted
    // string contents would report "not found" for a file that plainly has it.
    // What is removed here is COMMENTS, which is the entire point: these files
    // explain at length why they do not do the thing being checked.
    if (ch === BACKSLASH) {
      out += text[i] + (text[i + 1] ?? '');
      i += 2;
      continue;
    }
    out += text[i];
    if (String.fromCharCode(ch) === mode) mode = 'code';
    i += 1;
  }

  return out;
}




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
  // `tests/` is excluded, and the exclusion is by name rather than by guesswork.
  // A test that asserts "a private key block is refused" has to WRITE one, and a
  // scanner that cannot tell a fixture from a leak is a scanner nobody trusts.
  if (rel(file).startsWith('tests/')) continue;
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
/* 3. .env.local is git-ignored and absent, and no credential file can be    */
/* ------------------------------------------------------------------------ */

const gitignore = existsSync(join(ROOT, '.gitignore')) ? read('.gitignore') : '';
const ignored = /^\.env\*?\.local/m.test(gitignore) || /^\.env$/m.test(gitignore) || /^\.env\*/m.test(gitignore);
const localAbsent = !existsSync(join(ROOT, '.env.local'));
check('.env.local is git-ignored', ignored);
check('.env.local is not committed', localAbsent, localAbsent ? '' : '.env.local exists in the tree');

/**
 * EVERY env filename that must be ignored, actually is — checked by BEHAVIOUR.
 *
 * The assertion above is `A || B || C` over three patterns, so it passes as soon
 * as ANY of them is present, and it says nothing about which files those patterns
 * cover. That is how a real gap survived an audit: the patterns were all present,
 * the check was green, and `.env.production` was not ignored — because every rule
 * in the file ended in `.local` and `.env.production` does not.
 *
 * `.env.production` is a conventional Next.js filename. A developer or a deploy
 * script creates it without thinking about it, which is exactly the moment this
 * list is supposed to save them from. So this check names the FILES and asks git
 * to resolve the patterns, rather than reading the patterns and hoping.
 *
 * `check-ignore -q` is a real invocation, not a reimplementation of gitignore
 * semantics — reimplementing them is how a second tool ends up disagreeing with
 * the first. `--no-index` is implied by passing a name that does not exist on
 * disk, so this works on a clean checkout with no `.env.local` present.
 */
const MUST_IGNORE = [
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local',
  // The three that the audit found uncovered. They have no `.local` suffix, so a
  // list of `.local` rules misses all of them.
  '.env.production',
  '.env.staging',
  '.env.development',
];
/** Must stay COMMITTED — an ignored example defeats the purpose of an example. */
const MUST_COMMIT = ['.env.example', '.env.production.example'];

function gitIgnores(name) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', name], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Exit 1 means "not ignored", which is an answer rather than a failure.
    return false;
  }
}

const notIgnored = MUST_IGNORE.filter((name) => !gitIgnores(name));
const wronglyIgnored = MUST_COMMIT.filter((name) => gitIgnores(name));
check(
  'Every .env filename is git-ignored, including the ones without a .local suffix',
  notIgnored.length === 0,
  `not ignored: ${notIgnored.join(', ')}`,
);
check(
  '.env.example stays committable (an ignored example is a useless example)',
  wronglyIgnored.length === 0,
  `wrongly ignored: ${wronglyIgnored.join(', ')}`,
);

/**
 * NO CREDENTIAL-CLASS VARIABLE IS POPULATED IN `.env.example`.
 *
 * The existing check covers a fixed list of names. This one is the complement:
 * it walks EVERY assignment in the file and fails on any whose VALUE is non-empty
 * for a name that looks like a credential — so adding `SOME_NEW_API_TOKEN=` with
 * a real value is caught by the pattern rather than by remembering to extend a
 * list.
 *
 * `NEXT_PUBLIC_*` is EXCLUDED, and deliberately. The Firebase web config and the
 * Maps browser key are public by construction — they ship to every browser and
 * are protected by API/HTTP-referrer restriction instead (docs/10 §14.3, B3).
 * Treating them as secrets is the mistake docs/24 T-14 is careful to avoid, and a
 * check that flagged them would push someone toward NOT shipping a key that has
 * to ship.
 */
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|SALT)/i;
const populatedCredentials = [];
for (const line of envExample.split('\n')) {
  const bare = line.split('#')[0].trim();
  const match = bare.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  const [, name, rawValue] = match;
  if (name.startsWith('NEXT_PUBLIC_')) continue;
  if (!SECRET_NAME.test(name)) continue;
  // A trailing `# comment` is not a value. `.env.production=` followed by prose is
  // the documented house style in this repo, and reading the comment as a secret
  // would flag the very lines that are the safest in the file.
  const value = rawValue.split('#')[0].trim();
  if (value !== '') populatedCredentials.push(name);
}
check(
  'No credential-class variable is populated in .env.example',
  populatedCredentials.length === 0,
  `populated: ${populatedCredentials.join(', ')}`,
);

/**
 * Credential files are ignored BY EXTENSION, not by name.
 *
 * A `service-account.json` rule alone is not enough: a PEM exported as
 * `firebase-key.pem`, or a keystore as `upload.jks`, is the same credential
 * under a different extension. `.gitignore` therefore lists the extensions AND
 * the well-known filenames, and this check fails if any of them is removed —
 * a `.gitignore` that quietly stops excluding a key looks exactly like one that
 * never did.
 */
const CREDENTIAL_IGNORE_RULES = [
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*service-account*.json',
  '*serviceAccount*.json',
  'firebase-adminsdk-*.json',
  '.vercel/',
];
const missingCredentialRules = CREDENTIAL_IGNORE_RULES.filter(
  (rule) => !gitignore.split('\n').some((line) => line.trim() === rule),
);
check(
  'Private credential files are git-ignored',
  missingCredentialRules.length === 0,
  missingCredentialRules.join('; '),
);

/**
 * NO FAKE API KEY ANYWHERE.
 *
 * A placeholder key is worse than a missing one: a real provider rejects it with
 * an error that looks exactly like a network fault, and a reviewer loses an
 * afternoon to it. The Firebase web config is a real key shape and IS expected
 * to appear in `.env.example` — empty. This checks the source tree only, where
 * any key-shaped literal is a bug.
 */
const FAKE_KEY = {
  name: 'placeholder or hard-coded API key',
  re: /AIza[0-9A-Za-z_-]{10,}/,
};
const fakeKeyHits = [];
for (const file of files) {
  if (rel(file).startsWith('tests/')) continue;
  if (FAKE_KEY.re.test(code(rel(file)))) fakeKeyHits.push(rel(file));
}
check('No key-shaped literal in the source tree', fakeKeyHits.length === 0, fakeKeyHits.join('; '));

/**
 * NO `NEXT_PUBLIC_` VARIABLE PUBLISHES A SERVER SECRET.
 *
 * Anything prefixed `NEXT_PUBLIC_` is INLINED into the client bundle by Next at
 * build time — not obfuscated, not encrypted, in the JavaScript every visitor
 * downloads. docs/21 §7 requires the build to fail if a `NEXT_PUBLIC_` value
 * matches a server-secret pattern, and this is that check.
 */
const SERVER_SECRET_NAMES = [
  'GEMINI_API_KEY',
  'GOOGLE_MAPS_SERVER_KEY',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_ACCOUNT_SID',
  'CRON_SECRET',
  'IP_HASH_SALT',
  'SEED_DEMO_PASSWORD',
];
const publishOffenders = [];
for (const file of files) {
  if (rel(file).startsWith('tests/')) continue;
  for (const line of code(rel(file)).split('\n')) {
    const match = line.match(/process\.env\.([A-Z0-9_]+)/g) ?? [];
    for (const reference of match) {
      const name = reference.replace('process.env.', '');
      if (!name.startsWith('NEXT_PUBLIC_')) continue;
      if (SERVER_SECRET_NAMES.some((secret) => name.includes(secret))) {
        publishOffenders.push(`${rel(file)}: ${name}`);
      }
    }
  }
}
check(
  'No NEXT_PUBLIC_ variable publishes a server secret',
  publishOffenders.length === 0,
  publishOffenders.join('; '),
);

/**
 * EACH PROVIDER SECRET IS READ IN EXACTLY ONE FILE.
 *
 * `rg GEMINI_API_KEY` must be a complete audit of where a key can be read. Two
 * readers means two places to forget a timeout, two places to log it by
 * accident, and no way to rotate it with confidence. The one legitimate reader
 * is the env accessor, which owns the validation and the defaults.
 *
 * `tests/` is excluded because a test that asserts "this secret is read in one
 * place" has to NAME the secret to assert it.
 */
const ONE_READER_SECRETS = ['GEMINI_API_KEY', 'GOOGLE_MAPS_SERVER_KEY', 'TWILIO_AUTH_TOKEN'];
const multiReaderOffenders = [];
for (const secret of ONE_READER_SECRETS) {
  const readers = files
    .map(rel)
    .filter((file) => !file.startsWith('tests/'))
    .filter((file) => code(file).includes(secret));
  if (readers.length !== 1 || readers[0] !== 'lib/env.server.ts') {
    multiReaderOffenders.push(`${secret}: ${readers.join(', ') || 'nowhere'}`);
  }
}
check(
  'Each provider secret is read only by lib/env.server.ts',
  multiReaderOffenders.length === 0,
  multiReaderOffenders.join('; '),
);

/**
 * NO SERVICE, INTEGRATION, VALIDATOR, OR ROUTE READS `process.env`.
 *
 * The rule is "secrets come from `lib/env.server.ts`, once". A direct read
 * anywhere else bypasses the validation, the clamping, and the boot check. The
 * five files outside `lib/env.*` that legitimately read the environment each
 * read `NODE_ENV` or a documented boolean, and are listed so adding a sixth is a
 * deliberate act rather than an accident.
 */
const ENV_ALLOWED = new Set([
  'lib/env.server.ts',
  'lib/env.client.ts',
  'lib/env.maintenance.ts',
  // Reads `NODE_ENV` to relax HSTS and the CSP in development, and to set
  // `X-Robots-Tag`. Neither is a secret and neither is available on the client.
  'middleware.ts',
  // Reads `LOG_LEVEL` directly so a logger can never be prevented from logging by
  // a missing secret — a real Phase 2 bug, recorded in
  // `tests/unit/unconfigured-deployment.test.ts`.
  'lib/server/http.ts',
  'lib/api/client.ts',
  'lib/firebase/auth.ts',
  // Reads `NODE_ENV` for a development-only warning. Not a secret, and a client
  // component legitimately needs to know whether it is a development build.
  'components/providers/session-provider.tsx',
]);
const envOffenders = files
  .map(rel)
  .filter((file) => !ENV_ALLOWED.has(file))
  .filter((file) => !file.startsWith('tests/'))
  .filter((file) => code(file).includes('process.env'));
check(
  'process.env is read only by the env accessors',
  envOffenders.length === 0,
  envOffenders.join('; '),
);


/**
 * NO INTEGRATION HAS A DEV-ONLY SUCCESS BRANCH.
 *
 * docs/32 MUST 7: no `if (DEV) return FAKE_DATA` in a production path. A branch
 * that could make a Gemini call, a geocode, or an SMS send "succeed" without a
 * provider would be fabricated behaviour in an emergency system, and it would be
 * invisible in a demo.
 */
const INTEGRATIONS = [
  'services/integrations/gemini/index.ts',
  'services/integrations/google-maps/index.ts',
  'services/integrations/twilio/index.ts',
];
const fakeBranchOffenders = INTEGRATIONS.filter((file) => {
  if (!existsSync(join(ROOT, file))) return true;
  const text = code(file);
  return /NODE_ENV|import\.meta\.env|\bDEV\b/.test(text);
});
check(
  'No integration has a dev-only data branch',
  fakeBranchOffenders.length === 0,
  fakeBranchOffenders.join('; '),
);

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
  // Phase 3. Each of these can reach a secret or a server-only SDK, so the
  // poison pill is what stops a client bundle from ever including it. The
  // `server-only` import is a BUILD error, which is a far stronger guarantee
  // than a review convention.
  //
  // `lib/env.client.ts` is deliberately NOT in this list: it is the browser-safe
  // accessor and adding the guard to it would break the landing page.
  'lib/server/logging.ts',
  'lib/server/validate.ts',
  'lib/server/rate-limit.ts',
  'lib/server/serialize.ts',
  'lib/server/permissions.ts',
  'services/auth/account.ts',
  'services/admin/system-health.ts',
  'services/ai/triage.ts',
  'services/ai/audit.ts',
  // Phase 4. `client.ts` constructs the `GoogleGenAI` client, which is a
  // credentialed SDK handle, and `index.ts` is the policy layer above it. Both are
  // banned from the client tree by the guard AND by check 9 below.
  'services/integrations/gemini/index.ts',
  'services/integrations/gemini/client.ts',
  'services/integrations/google-maps/index.ts',
  'services/integrations/twilio/index.ts',
];
const missingGuard = SERVER_MODULES.filter((path) => {
  if (!existsSync(join(ROOT, path))) return true;
  return !/^\s*import 'server-only';/m.test(read(path));
});
check('Every secret-reading module has `server-only`', missingGuard.length === 0, missingGuard.join('; '));

/**
 * `lib/integrations/contracts.ts` is deliberately EXCLUDED from the list above,
 * and the exclusion is asserted rather than assumed.
 *
 * It is the one file a Client Component and a unit test are both allowed to
 * import, which is the entire reason it is a pure interface file. Adding the
 * guard would break both, and nothing would fail to tell you why. Its protection
 * is PURENESS: there is nothing in it to leak, which this check confirms.
 */
const contractsPath = 'lib/integrations/contracts.ts';
const contractsIsPure =
  existsSync(join(ROOT, contractsPath)) &&
  !/^\s*import 'server-only';/m.test(read(contractsPath)) &&
  !code(contractsPath).includes('process.env') &&
  !code(contractsPath).includes('fetch(') &&
  // An IMPORT of the SDK, not the string. `'firebase-admin'` is a legitimate
  // value in the `ProviderStatus.provider` union, so a substring test here
  // would report a false positive and train an operator to ignore the check.
  !/from\s+['"]firebase-admin/.test(code(contractsPath));
check(
  'lib/integrations/contracts.ts stays pure (no guard, no env, no SDK)',
  contractsIsPure,
  'the contract file must be importable from a client bundle and a unit test',
);

/**
 * `services/ai/schema.ts` is pure for the same reason, and the same reason makes
 * this a separate assertion rather than a clause above.
 *
 * doc 09 §3 requires `lib/validation/ai.ts` to re-export the Zod schema "so both
 * client and server share one definition". That requirement only works if the
 * module is importable from a Client Component, which means it must not carry the
 * `server-only` guard and must not import anything that can reach a secret.
 *
 * This check is the thing that makes the exclusion in the list above defensible
 * rather than merely asserted in a comment: adding `import 'server-only'` to
 * `schema.ts` would break every AI test, and importing `@google/genai` or
 * `node:crypto` into it would put a provider SDK into a client bundle. Both fail
 * here with the file named.
 */
const schemaPath = 'services/ai/schema.ts';
const schemaIsPure =
  existsSync(join(ROOT, schemaPath)) &&
  !/^\s*import 'server-only';/m.test(read(schemaPath)) &&
  !code(schemaPath).includes('process.env') &&
  !code(schemaPath).includes('fetch(') &&
  !/@google\/genai/.test(code(schemaPath)) &&
  // `sanitize.ts` and `rules.ts` are pure by the same argument, and they are
  // reachable from a future client-side preview, so the rule is stated once as a
  // list rather than copied three times.
  ['services/ai/prompts.ts', 'services/ai/sanitize.ts', 'services/ai/rules.ts', 'services/ai/fallback.ts'].every(
    (path) =>
      existsSync(join(ROOT, path)) &&
      !/^\s*import 'server-only';/m.test(read(path)) &&
      !code(path).includes('process.env'),
  );
check(
  'The AI schema and rules stay pure (shareable with the client)',
  schemaIsPure,
  'schema/prompts/sanitize/rules/fallback must stay importable without the guard or an env read',
);

/**
 * THE AI OUTPUT SCHEMA IS `.strict()`, AND THAT IS A SAFETY CONTROL.
 *
 * docs/09 §5.1: "any extra key is a validation failure — this is the primary
 * defence against a manipulated model returning a `dispatch: true` field."
 *
 * The prompt cannot be relied on to stop that, and the caller only reads named
 * fields, so the barrier is the schema itself. `.strict()` is easy to lose to a
 * well-meaning edit — `z.object({...})` and `z.object({...}).strict()` are
 * interchangeable-looking, and nothing else fails when it is dropped. This check
 * exists so the loss is a build failure rather than a phase where a persuasive
 * model dispatches someone.
 */
const aiSchemaText = existsSync(join(ROOT, schemaPath)) ? code(schemaPath) : '';
check(
  'The AI output schema is .strict()',
  /\.object\([\s\S]*?\)\s*\.strict\(\)/.test(aiSchemaText),
  'services/ai/schema.ts must end its output object with .strict()',
);

/**
 * THE AI CANNOT DISPATCH, AND THE TYPE IS THE PROOF.
 *
 * docs/09 §1.2 and MUST NOT 8. A `TriageResult` with a field for a coordinate, a
 * casualty count, or a resource would be an invitation, and the prohibition has to
 * be structural rather than a convention someone could forget — there is no code
 * review at the moment a model returns something unexpected.
 *
 * The check is on the TYPE, not on a grep for "dispatch" in the implementation,
 * because a dispatch field could be named anything.
 */
const contractsText = existsSync(join(ROOT, contractsPath)) ? code(contractsPath) : '';
const resultBlock = contractsText.match(/export type TriageResult = \{[\s\S]*?\n\};/);
const forbiddenResultFields = ['dispatch', 'responderId', 'latitude', 'longitude', 'lat', 'lng', 'coordinates', 'diagnosis', 'peopleAffected', 'assignedTo'];
const leakedFields = resultBlock
  ? forbiddenResultFields.filter((field) => new RegExp(`\\b${field}\\b`).test(resultBlock[0]))
  : ['(TriageResult not found)'];
check(
  'TriageResult cannot carry a dispatch, a coordinate, or a casualty count',
  leakedFields.length === 0,
  `forbidden field(s) in TriageResult: ${leakedFields.join(', ')}`,
);

/**
 * THE MOCK IS REFUSED IN PRODUCTION, MECHANICALLY.
 *
 * brief §26 asks for `AI_MOCK_MODE`; docs/32 MUST 7 forbids a provider that can
 * "succeed" without one. The reconciliation is that the flag is honoured only
 * when it is not production AND no real key is present, and this check verifies
 * the REFUSAL is in the code rather than trusting the comment that says it is.
 *
 * A mock that reached production would be the most dangerous line in the project:
 * every field would look populated and nothing would have been assessed.
 */
const envServerText = existsSync(join(ROOT, 'lib/env.server.ts')) ? code('lib/env.server.ts') : '';
check(
  'AI_MOCK_MODE is refused in production and shadowed by a real key',
  /isAiMockMode[\s\S]*?NODE_ENV\s*===\s*'production'[\s\S]*?return false/.test(envServerText) &&
    /isAiMockMode[\s\S]*?GEMINI_API_KEY/.test(envServerText) &&
    /AI_MOCK_MODE is enabled/.test(envServerText),
  'lib/env.server.ts must refuse AI_MOCK_MODE in production and ignore it when a key exists',
);

/**
 * `AI_MOCK_MODE` IS EMPTY IN `.env.example`.
 *
 * A checked-in example with the flag ON is a deployment that inherits it, and the
 * whole point of the production refusal is a second line of defence.
 */
check(
  'AI_MOCK_MODE is empty in .env.example',
  !/^AI_MOCK_MODE=.+/m.test(envExample),
  'AI_MOCK_MODE must ship empty',
);

/* ------------------------------------------------------------------------ */
/* 9. The client never imports a server module                               */
/* ------------------------------------------------------------------------ */

const SERVER_PATTERN = /from '@\/(lib\/server\/|env\.server|env\.maintenance)/;
const clientOffenders = [];
for (const file of files) {
  const path = rel(file);
  // Route handlers ARE server, and a server module importing another server
  // module is the whole point of the lib/server boundary. `services/**` is
  // server-only for the same reason, and is banned from the client tree.
  // `tests/**` is excluded because a test asserts these boundaries and
  // therefore has to import across them.
  if (
    path.startsWith('app/api') ||
    path.startsWith('lib/server') ||
    path.startsWith('services') ||
    path.startsWith('tests/')
  ) {
    continue;
  }
  const text = code(path);
  if (SERVER_PATTERN.test(text)) clientOffenders.push(path);
  if (/from '@\/services/.test(text)) clientOffenders.push(`${path} (imports @/services)`);
}
check('No client-reachable file imports a server module', clientOffenders.length === 0, clientOffenders.join('; '));


/* ------------------------------------------------------------------------ */
/* 10. Firebase credentials are environment variables, never literals        */
/* ------------------------------------------------------------------------ */

const firebaseConfigHits = [];
for (const file of files) {
  const text = code(rel(file));
  // An `initializeApp({ ... })` with a literal apiKey would be a hard-coded
  // credential. The config must come from `getPublicConfig()`.
  if (/initializeApp\(\s*\{/.test(text) && /apiKey\s*:/.test(text)) {
    firebaseConfigHits.push(rel(file));
  }
}
check('No hard-coded Firebase config', firebaseConfigHits.length === 0, firebaseConfigHits.join('; '));

/* ------------------------------------------------------------------------ */
/* 11. No CORS, and no permissive cross-origin policy                        */
/* ------------------------------------------------------------------------ */

// `tests/` is excluded because a test that asserts "no CORS header is set" has to
// NAME the header to assert it.
const corsOffenders = files
  .map(rel)
  .filter((file) => !file.startsWith('tests/'))
  .filter((file) => /Access-Control-Allow-(Origin|Credentials)/.test(code(file)));
check(
  'No Access-Control-Allow-Origin anywhere (docs/10 §12.2)',
  corsOffenders.length === 0,
  corsOffenders.join('; '),
);


/* ------------------------------------------------------------------------ */
/* 12. The security headers are present and not permissive                   */
/* ------------------------------------------------------------------------ */

const middleware = existsSync(join(ROOT, 'middleware.ts')) ? code('middleware.ts') : '';
const HEADERS = [
  ['Content-Security-Policy', /'Content-Security-Policy'/],
  ['X-Content-Type-Options', /'X-Content-Type-Options':\s*'nosniff'/],
  ['X-Frame-Options', /'X-Frame-Options':\s*'DENY'/],
  ['Referrer-Policy', /'Referrer-Policy'/],
  ['Permissions-Policy', /'Permissions-Policy'/],
  // Required for signInWithPopup; the browser default of `same-origin` severs
  // the window handle and Google sign-in silently fails.
  ['Cross-Origin-Opener-Policy', /'Cross-Origin-Opener-Policy':\s*'same-origin-allow-popups'/],
  ['Cross-Origin-Resource-Policy', /'Cross-Origin-Resource-Policy':\s*'same-origin'/],
  ['Strict-Transport-Security', /'Strict-Transport-Security'/],
];
const missingHeaders = HEADERS.filter(([, pattern]) => !pattern.test(middleware)).map(([name]) => name);
check('Every documented security header is set', missingHeaders.length === 0, missingHeaders.join('; '));

/**
 * The production `script-src` must carry a nonce and no `'unsafe-inline'`.
 *
 * The dev-only `'unsafe-eval'` is stripped first: React Fast Refresh genuinely
 * requires it, and a dev allowance cannot affect a production deployment.
 */
const scriptSrcLine = middleware.split('\n').find((line) => /^\s*`?script-src /.test(line)) ?? '';
const productionScriptSrc = scriptSrcLine.replace("'unsafe-eval'", '');
check(
  "script-src has a nonce and no 'unsafe-inline'",
  productionScriptSrc.includes("'nonce-") && !productionScriptSrc.includes('unsafe-inline'),
  scriptSrcLine.trim(),
);
check('script-src-attr is none', /"script-src-attr 'none'"/.test(middleware));
check("object-src is 'none'", /"object-src 'none'"/.test(middleware));
check("frame-ancestors is 'none'", /"frame-ancestors 'none'"/.test(middleware));
check("base-uri is 'self'", /"base-uri 'self'"/.test(middleware));
check("form-action is 'self'", /"form-action 'self'"/.test(middleware));

/**
 * `img-src` must not be `https:`.
 *
 * A wildcard in `img-src` permits loading an image from ANY host, which is the
 * same class of mistake as `'unsafe-inline'`. The real list is short and
 * knowable, so there is no reason to be vague.
 */
const imgSrcLine = middleware.split('\n').find((line) => /^\s*"img-src /.test(line)) ?? '';
check('img-src is an explicit host list, not https:', !/img-src[^"]*\shttps:[;"]/.test(imgSrcLine), imgSrcLine.trim());

/* ------------------------------------------------------------------------ */
/* 13. The rate-limit store is never PINNED to `memory`                       */
/* ------------------------------------------------------------------------ */

/**
 * A PIN, in either of the two forms that could actually do it.
 *
 * 1. A code assignment: `process.env.RATE_LIMIT_STORE = 'memory'`. Nothing in
 *    this repository does that, and a deployment sets the variable on the
 *    platform rather than in code.
 * 2. A committed env FILE with `RATE_LIMIT_STORE=memory`.
 *
 * The naive version of this check is a substring search for the text
 * `RATE_LIMIT_STORE=memory`, which matches the sentence inside
 * `serverEnvProblems()` that REPORTS the value as unsafe. Flagging the detector
 * is how a check gets switched off, so the pattern is narrowed to an assignment
 * and a file line, and the detector is left alone.
 */
const pinPatterns = [
  /process\.env\.RATE_LIMIT_STORE\s*=\s*['"]memory['"]/,
  /^\s*RATE_LIMIT_STORE\s*=\s*memory\s*$/m,
];
const rateLimitStoreHits = [];
for (const file of files) {
  if (rel(file).startsWith('tests/')) continue;
  if (pinPatterns.some((re) => re.test(code(rel(file))))) rateLimitStoreHits.push(rel(file));
}
if (/^\s*RATE_LIMIT_STORE\s*=\s*memory\s*$/m.test(envExample)) {
  rateLimitStoreHits.push('.env.example');
}
check('No source pins RATE_LIMIT_STORE to memory', rateLimitStoreHits.length === 0, rateLimitStoreHits.join('; '));



/* ------------------------------------------------------------------------ */
/* 14. `ALLOW_SEED` is never enabled in committed configuration               */
/* ------------------------------------------------------------------------ */

const seedHits = [];
for (const line of envExample.split('\n')) {
  const bare = line.split('#')[0].trim();
  if (bare.startsWith('ALLOW_SEED=') && bare.slice('ALLOW_SEED='.length).trim() === 'true') {
    seedHits.push('ALLOW_SEED=true in .env.example');
  }
}
check('ALLOW_SEED is false in .env.example', seedHits.length === 0, seedHits.join('; '));

/* ========================================================================== */
/* Phase 5 — evidence uploads (docs/15)                                        */
/* ========================================================================== */

/**
 * These are the checks that must NOT be satisfiable by a comment, a type alias or
 * a well-intentioned constant. Each one below is written to fail on the specific
 * mutation it is guarding, and each was verified to fail by actually making that
 * mutation.
 */

/**
 * 1. The path regexes must CAPTURE what `validateMediaPath` destructures.
 *
 * This check exists because of a bug this phase shipped with.
 *
 * `STAGING_PATH_RE` was written as `^staging/[A-Za-z0-9_-]{1,128}/med_[A-Z2-7]{12}\.(ext)$`
 * — a correct regex with NO capture groups. `validateMediaPath` destructures
 * `exec()`'s groups, so `uid` was `undefined`, `undefined !== callerUid` was
 * always true, and the function returned `null` for every possible input. Every
 * upload would have been silently dropped while the regex "passed" every test that
 * only called `.test()`.
 *
 * So the check counts capture groups, not matches. A `.test()`-based check would
 * have passed throughout.
 */
const captureGroupCount = (source) => (source.match(/\((?!\?)/g) ?? []).length;

/**
 * Pull the template literal out of `export const NAME = new RegExp(` … `)`.
 *
 * Written as index scanning rather than a regex because the thing being searched
 * for contains a BACKTICK, and a backtick inside a regex built from a template
 * literal needs escaping that is easy to get wrong in a way that fails at PARSE
 * time rather than at match time. Index arithmetic has no such hazard.
 */
function regexTemplateLiteral(source, name) {
  const marker = `export const ${name} = new RegExp(`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const open = source.indexOf('`', start + marker.length);
  if (open === -1) return null;
  const close = source.indexOf('`', open + 1);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

const pathRegexShapes = {
  STAGING_PATH_RE: 3,
  FINAL_PATH_RE: 5,
  QUARANTINE_PATH_RE: 2,
};
const uploadValidator = code('validators/upload.ts');
const captureFailures = [];
for (const [name, expected] of Object.entries(pathRegexShapes)) {
  const template = regexTemplateLiteral(uploadValidator, name);
  if (template === null) {
    captureFailures.push(`${name} not found as a template-literal RegExp`);
    continue;
  }
  const actual = captureGroupCount(template);
  if (actual !== expected) {
    captureFailures.push(
      `${name} declares ${actual} capture group(s), validateMediaPath destructures ${expected}`,
    );
  }
}
check(
  'Every media path regex captures the segments its parser reads',
  captureFailures.length === 0,
  captureFailures.join('; '),
);

/**
 * 2. The three path shapes must not be widened by a looser character class.
 *
 * `docs/15 §3.4` specifies these character classes exactly. A `.` or `..` added to
 * the uid class, or a `*` added to a quantifier, opens a traversal or an unbounded
 * id. The check asserts the literal class text is present, which is brittle on
 * purpose: a deliberate change to the path contract should have to update this
 * check, because that is a contract change and not a refactor.
 */
const pathClassInvariants = [
  ['staging uid class', 'staging/([A-Za-z0-9_-]{1,128})/'],
  ['media id class', '(med_[A-Z2-7]{12})'],
  ['incident id is exactly 20', 'incidents/([A-Za-z0-9]{20})/'],
];
const classFailures = pathClassInvariants
  .filter(([, needle]) => !uploadValidator.includes(needle))
  .map(([label]) => `${label} no longer matches the docs/15 §3.4 form`);
check(
  'Media path character classes are the docs/15 §3.4 ones',
  classFailures.length === 0,
  classFailures.join('; '),
);

/**
 * 3. `generateMediaId` must loop over `MEDIA_ID_BODY_LENGTH`, not the alphabet length.
 *
 * The second bug from this phase: `randomBytes(MEDIA_ID_ALPHABET.length)` with a
 * loop bound of the same value emits a 32-character body, while `MEDIA_ID_RE`
 * demands exactly 12. Every id the server minted failed its own regex, so every
 * signed URL pointed at a path Storage would refuse. The two numbers are 32 and
 * 12 and nothing about the expression distinguishes them, so this is asserted.
 */
const signUploadSource = code('services/uploads/sign-upload.ts');
const generatorBindsLength =
  /randomBytes\(MEDIA_ID_BODY_LENGTH\)/.test(signUploadSource) &&
  /i\s*<\s*MEDIA_ID_BODY_LENGTH/.test(signUploadSource);
const generatorRejectsAlphabetLength =
  /randomBytes\(MEDIA_ID_ALPHABET\.length\)/.test(signUploadSource) ||
  /i\s*<\s*MEDIA_ID_ALPHABET\.length/.test(signUploadSource);
check(
  'generateMediaId is bounded by MEDIA_ID_BODY_LENGTH, not the alphabet length',
  generatorBindsLength && !generatorRejectsAlphabetLength,
  generatorRejectsAlphabetLength
    ? 'generateMediaId loops over MEDIA_ID_ALPHABET.length (32) instead of MEDIA_ID_BODY_LENGTH (12)'
    : !generatorBindsLength
      ? 'generateMediaId no longer references MEDIA_ID_BODY_LENGTH in both the draw and the loop'
      : '',
);

/**
 * 4. The sniffer must check dangerous signatures BEFORE any media signature.
 *
 * `docs/15 §6` and §5.4: a polyglot is defined by its first bytes, so a file whose
 * header is `PK\x03\x04` is a ZIP no matter what follows. Checking the media
 * formats first would let a file that someone wrote a JPEG header onto reach the
 * allow-list. The check reads the source ORDER of the two loops rather than
 * trusting a comment, and a reordered detector is exactly the mutation that would
 * otherwise be invisible.
 */
const sniffSource = code('services/uploads/sniff.ts');
const dangerousLoop = sniffSource.indexOf(
  'for (const [label, signature] of DANGEROUS_SIGNATURES)',
);
const firstMediaCall = sniffSource.indexOf('jpegLooksReal(buf)');
/**
 * Both indices must be FOUND as well as ordered.
 *
 * This check shipped with only the ordering test, and mutation testing caught
 * why that is not enough: `String.prototype.indexOf` returns `-1` when a
 * substring is absent, and `-1 < anything` is `true`. Deleting the
 * dangerous-signature loop entirely therefore SATISFIED the check — the exact
 * regression it exists to catch. A "is A before B" assertion on two strings has
 * to assert existence, or it is asserting `-1 < n`, which is a tautology.
 */
check(
  'The sniffer checks executable signatures before any media signature',
  dangerousLoop !== -1 && firstMediaCall !== -1 && dangerousLoop < firstMediaCall,
  dangerousLoop === -1
    ? 'detectMediaType no longer iterates DANGEROUS_SIGNATURES'
    : firstMediaCall === -1
      ? 'detectMediaType no longer calls jpegLooksReal'
      : 'the media checks run before the dangerous-signature loop',
);

/**
 * 5. `resolveEvidenceRead` must not distinguish "absent" from "forbidden".
 *
 * `docs/15 §16.4` requires the two to be byte-identical. If a future change gives
 * the permission case a different code or message, that is an existence oracle:
 * a caller could enumerate `mediaId`s and learn which reports exist. The check
 * counts the distinct refusal constructions INSIDE that one function — it must be
 * exactly one, hoisted to a shared `REFUSAL` and re-thrown.
 *
 * Scoped to the function, not the file. `readStagedForAi` legitimately raises
 * `MEDIA_NOT_FOUND` too, and counting it here would make this check fail for an
 * unrelated reason and train a reader to ignore it. A check that is right by luck
 * is worse than no check, because the next real regression will be dismissed as
 * "the check is noisy".
 */
const attachSource = code('services/uploads/evidence-attach.ts');
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  // Walk braces from the signature's own opening brace. A `}` inside a string or
  // a comment would end this early, so this is a lower bound on the body rather
  // than an exact slice — which is fine, because an over-long body can only make
  // the count HIGHER, and the check fails if the count is not exactly 1.
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}
const readBody = functionBody(attachSource, 'export async function resolveEvidenceRead');
const refusalConstructions = (
  readBody.match(/new AppError\(\{\s*code: 'MEDIA_NOT_FOUND'/g) ?? []
).length;
const hasSharedRefusal = /const REFUSAL = new AppError\(/.test(readBody);
check(
  'Evidence read has ONE refusal, shared by absent, unverified and forbidden',
  readBody.length > 0 && hasSharedRefusal && refusalConstructions === 1,
  readBody.length === 0
    ? 'resolveEvidenceRead not found'
    : `found ${refusalConstructions} MEDIA_NOT_FOUND constructions in resolveEvidenceRead; docs/15 §16.4 requires one`,
);

/**
 * 6. A `MediaRef` must not carry a persisted `downloadUrl`.
 *
 * brief §16's example shape includes an optional `downloadUrl`. It is deliberately
 * omitted: a Firebase download URL is a long-lived bearer token, and storing one
 * in a document that anyone who can read the incident can read means the URL
 * outlives the authorization decision that produced it. `types/media.ts` documents
 * the reasoning. This check makes removing that decision a deliberate act.
 */
const mediaTypes = code('types/media.ts');
check(
  'MediaRef stores no downloadUrl (read URLs are minted per request)',
  !/^\s*readonly downloadUrl[?:]/m.test(mediaTypes),
  'types/media.ts declares a persisted downloadUrl on MediaRef',
);

/**
 * 7. The browser PUT must not send a `Content-Type` the signature does not cover.
 *
 * The V4 signature is computed over the content type, so sending `file.type` when
 * the server signed `signed.requiredContentType` is a 403 from Google with a
 * message about a signature. The two are usually equal and are not always — a blob
 * assembled by the recorder echoes whatever the recorder was configured with. The
 * check insists the signed value is what is sent.
 */
const uploadManagerSource = code('features/reporting/upload-manager.ts');
const sendsSignedContentType = /setRequestHeader\(\s*'Content-Type',\s*contentType\s*\)/.test(
  uploadManagerSource,
);
const signedValueIsSent = /putWithProgress\(\s*signed\.uploadUrl,\s*file,\s*signed\.requiredContentType/.test(
  uploadManagerSource.replace(/\s+/g, ' '),
);
check(
  'The browser PUT sends the SIGNED content type, not the file own type',
  sendsSignedContentType && signedValueIsSent,
  'putWithProgress must send signed.requiredContentType, not file.type',
);

/**
 * 8. Upload progress must come from real byte events, never a timer.
 *
 * brief §24: "Do not fake progress." A `setInterval` that increments a percentage
 * is the specific thing that is forbidden, and it is easy to reintroduce because
 * it looks like a loading state. The check looks for an interval or a synthetic
 * increment in the uploader, and requires the real `xhr.upload.onprogress` source.
 *
 * The recorder component legitimately HAS an interval — it is the elapsed-time
 * readout, which is real measured time and not a progress claim — so this check is
 * scoped to the upload path only.
 */
const hasRealProgress = /xhr\.upload\.onprogress/.test(uploadManagerSource);
const hasSyntheticProgress =
  /setInterval\([\s\S]{0,200}?(progress|percent)/i.test(uploadManagerSource);
check(
  'Upload progress comes from xhr.upload.onprogress, not a timer',
  hasRealProgress && !hasSyntheticProgress,
  !hasRealProgress
    ? 'no xhr.upload.onprogress — progress cannot be real'
    : 'a timer appears to advance the progress value',
);

/**
 * 9. The sweeper must not be silently implemented as a no-op.
 *
 * `docs/15 §16.2` requires a `sweep-staging-uploads` job that this phase does not
 * build. The function therefore THROWS rather than returning an empty report —
 * `{ scanned: 0, deleted: [] }` would tell a caller staging is clean, which is a
 * false statement. A mutation that returns an empty result is the failure mode
 * worth catching.
 */
const sweepThrows = /sweepAbandonedStaging[\s\S]{0,600}?throw new AppError/.test(attachSource);
const sweepReturnsEmpty = /sweepAbandonedStaging[\s\S]{0,600}?return\s*\{\s*scanned:\s*0/.test(
  attachSource,
);
check(
  'The staging sweeper refuses rather than reporting a false clean',
  sweepThrows && !sweepReturnsEmpty,
  sweepReturnsEmpty
    ? 'sweepAbandonedStaging returns an empty report, which claims staging is clean'
    : !sweepThrows
      ? 'sweepAbandonedStaging no longer throws'
      : '',
);

/**
 * 10. The transcript copy must not claim a responder was dispatched.
 *
 * brief §34 is an emergency-safety requirement, and it is the kind of thing that
 * gets "improved" by someone adding a reassuring sentence. The check scans
 * `services/speech/speech-to-text.ts` for the four phrasings brief §34 names.
 */
const speechSource = code('services/speech/speech-to-text.ts');
const dispatchClaims = [
  /emergency services (have|has) been notified/i,
  /help is on the way/i,
  /responders? (have|has) been dispatched/i,
  /alerted the authorities/i,
].filter((pattern) => pattern.test(speechSource));
check(
  'No speech copy claims a responder is on the way (brief §34)',
  dispatchClaims.length === 0,
  dispatchClaims.map(String).join('; '),
);

/* ------------------------------------------------------------------------ */
/* Report                                                                     */
/* ------------------------------------------------------------------------ */

const pad = Math.max(...results.map((r) => r.label.length));
let failed = 0;

console.log('CareGrid AI — security checklist\n');
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
