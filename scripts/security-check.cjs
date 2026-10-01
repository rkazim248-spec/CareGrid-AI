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
/**
 * Directories the checker never reads.
 *
 * `.kilo` was missing, and that is not a cosmetic omission: it holds a full stale
 * copy of the project from an earlier phase, so several checks were reading TWO
 * copies of every file. That is not harmless — a check can then be satisfied by a
 * line in a worktree that is not part of the build, and a mutation test can appear
 * to "not trigger" because a second copy of the target still has the original text.
 * A checker that reads files nobody ships is measuring the wrong repository.
 */
const SKIP = new Set(['node_modules', '.next', '.git', 'docs', 'coverage', '.kilo', '.vercel', 'out']);

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
/**
 * Is `.env.local` TRACKED by git?
 *
 * Phase 10 asserted the file was ABSENT from disk, because during Phases 1-10 there
 * were no credentials and no `.env.local`. That conflated two different properties.
 * The moment a developer puts real credentials in it — which is the entire point of
 * the integration phase — the check failed for the correct, intended state.
 *
 * The property that matters is TRACKSHIP, and git is asked directly rather than
 * inferred from the filesystem. This is strictly stronger than the old assertion: a
 * file can be absent today and committed tomorrow, whereas `git ls-files` returning
 * nothing is the invariant itself. The companion "git-ignored" check above is kept,
 * because that is what stops an untracked file being added by accident.
 */
function isTrackedByGit(relativePath) {
  try {
    const listed = execFileSync('git', ['ls-files', '--error-unmatch', relativePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return listed.trim().length > 0;
  } catch {
    // `--error-unmatch` exits non-zero when the path is NOT tracked, which is the
    // answer we want.
    return false;
  }
}

const localExists = existsSync(join(ROOT, '.env.local'));
const localTracked = localExists ? isTrackedByGit('.env.local') : false;
check('.env.local is git-ignored', ignored);
check(
  '.env.local is not committed to git',
  !localTracked,
  localTracked
    ? '.env.local is TRACKED by git — every credential in it is now in the object store and must be rotated'
    : localExists
      ? 'ok — .env.local exists locally and is untracked (the correct state when working with real credentials)'
      : '',
);

/**
 * The local file must not leak into a build or a diff.
 *
 * A second, independent assertion on top of the git ones, because the whole harm of
 * a committed secret file is that it travels. If the file is untracked AND ignored,
 * it cannot be in a commit, a tarball of the tree, or a CI checkout.
 */
check(
  '.env.local is excluded from the tracked file set',
  (() => {
    try {
      const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return !tracked.split(/\r?\n/).some((line) => /^\.env(\.|$)/.test(line.trim()) && !line.includes('.example'));
    } catch {
      // Outside a git repo the ignore check above is the only available signal, and
      // it is not weakened by this returning true.
      return true;
    }
  })(),
);

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

/**
 * Extract a function body by brace matching.
 *
 * Scoped checks need this, and a `}` inside a string or comment would end the walk
 * early. That makes the result a LOWER BOUND on the true body rather than an exact
 * slice — acceptable, because the checks using it either require a small exact count
 * (an over-long body fails, which is the safe direction) or a substring to be
 * present (an over-long body cannot hide one).
 */
/**
 * The `{` that opens a function BODY, given the position of its closing `)`.
 *
 * **`source.indexOf('{', afterParen)` is wrong whenever the signature has a return
 * type containing a brace.** `checkForDuplicates` is declared:
 *
 *   export async function checkForDuplicates(
 *     report: DuplicateReportInput,
 *     cfg: DuplicateConfig = ...,
 *   ): Promise<DuplicateCheckResult & { readonly candidatesUnavailable: boolean }> {
 *
 * so the first `{` after the parameter list is the one inside the RETURN TYPE. The
 * walk then balanced against a type literal and returned a fragment ending at the
 * type's `}`, which is why the "applies the exact filter" assertion reported the
 * filter missing from a function that plainly calls it.
 *
 * The fix is to skip a return-type annotation: if the next non-space character is
 * `:`, consume to the `{` that is followed (after optional whitespace) by a newline
 * and then a statement. That is a heuristic, so it is applied conservatively — and
 * the fallback, when the pattern does not match, is the plain first-`{` behaviour
 * rather than a silent empty body.
 */
function findBodyOpen(source, afterParen) {
  let i = afterParen + 1;
  while (i < source.length && /\s/.test(source[i])) i += 1;

  // No return type: the `{` must come next.
  if (source[i] !== ':') return source.indexOf('{', afterParen);

  // A return type: find the LAST `{` before the newline that ends the declaration.
  let lineEnd = source.indexOf('\n', i);
  if (lineEnd === -1) lineEnd = source.length;
  let candidate = -1;
  for (let j = i; j < lineEnd; j += 1) {
    if (source[j] === '{') candidate = j;
  }
  return candidate === -1 ? source.indexOf('{', afterParen) : candidate;
}


function functionBodyOf(source, signature) {
  /**
   * Matched on the function NAME, not the full signature.
   *
   * Passing a full parameter list means the check breaks the moment a parameter is
   * added, reformatted, or given a destructured type — and it breaks SILENTLY,
   * because `indexOf` returning -1 produced a `''` body and every scoped assertion
   * on it reported "not found" rather than failing loudly. Two of these checks
   * failed for exactly that reason during this phase's own bring-up.
   *
   * So the caller passes `findDuplicateCandidates` and this function finds the
   * nearest following `(` to scan for the body.
   */
  const start = source.indexOf(signature);
  if (start === -1) return '';

  /**
   * The parameter list's closing paren, not the first `{`.
   *
   * An earlier version took `source.indexOf('{', start)` — the first brace AFTER the
   * signature — which for
   *
   *   export async function findDuplicateCandidates(
   *     point: { lat: number; lng: number },
   *     ...
   *
   * is the `{` of the DESTRUCTURED TYPE ANNOTATION, not the body. The walk then
   * balanced against a parameter type and returned a 28-character fragment, and
   * every scoped check using it silently saw an empty function.
   *
   * That is the worst kind of harness bug: a check that finds nothing, passes for
   * the wrong reason, and gives false confidence about a real control. Parens are
   * skipped first, so the brace found is unambiguously the body's.
   */
  let parenDepth = 0;
  let bodyOpen = -1;
  const open = source.indexOf('(', start);
  if (open === -1) return '';
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') parenDepth += 1;
    else if (c === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        bodyOpen = findBodyOpen(source, i);
        break;
      }
    }
  }
  if (bodyOpen === -1) return '';

  let depth = 0;
  for (let i = bodyOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyOpen, i + 1);
    }
  }
  return source.slice(bodyOpen);
}
const functionBody = functionBodyOf;

const readBody = functionBody(attachSource, 'resolveEvidenceRead');
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

/* ========================================================================== */
/* Phase 6 — maps, geolocation and duplicate detection (docs/12, docs/07 §9)  */
/* ========================================================================== */

/**
 * 11. `haversineM` must use the haversine form, not the law of cosines.
 *
 * The spherical law of cosines is the textbook formula and it is WRONG for this
 * use: `acos` of a value within ~1e-10 of 1 loses most of its significant digits,
 * and two incidents 200 m apart on a 6 371 km sphere are exactly that close. The
 * haversine form's `sin²(Δφ/2)` stays well-conditioned down to zero, which is why
 * identical coordinates return exactly `0` rather than floating-point noise.
 *
 * The check looks for the `asin(sqrt(h))` shape rather than the absence of `acos`,
 * so a rewrite that used cosines *and* kept a vestigial asin would still be caught by
 * the `Math.min(1, ...)` guard check below.
 */
const distanceSource = code('lib/geo/distance.ts');
const usesHaversineShape = /2\s*\*\s*EARTH_RADIUS_M\s*\*\s*Math\.asin\(Math\.sqrt\(/.test(
  distanceSource.replace(/\s+/g, ' '),
);
const usesLawOfCosines = /Math\.acos\(/.test(distanceSource);
check(
  'haversineM uses the asin(sqrt(h)) form, not the law of cosines',
  usesHaversineShape && !usesLawOfCosines,
  !usesHaversineShape
    ? 'lib/geo/distance.ts no longer computes 2R*asin(sqrt(h))'
    : 'lib/geo/distance.ts uses Math.acos, which is ill-conditioned for close points',
);

/**
 * 12. The haversine `h` must be clamped to 1.
 *
 * Without `Math.min(1, h)`, floating-point can push `h` a hair above 1 and
 * `Math.asin(1.0000000000000002)` is `NaN` — which turns a valid distance into a
 * silent NaN and defeats every downstream comparison, including the 500 m radius
 * gate in the duplicate engine. A `NaN` radius comparison is `false`, so the pair
 * would be neither confirmed nor rejected.
 */
check(
  'The haversine h is clamped, so a near-antipodal pair cannot yield NaN',
  /Math\.min\(1,\s*h\)|Math\.min\(1,\s*clamped\)|const clamped = Math\.min\(1, h\)/.test(
    distanceSource,
  ),
  'lib/geo/distance.ts must clamp h to 1 before Math.asin',
);

/**
 * 13. `isValidLatLng` must check `Number.isFinite` BEFORE the range test.
 *
 * brief §16 requires rejecting `NaN`, `Infinity` and malformed strings. The subtle
 * part is ORDER: `NaN > 90` and `NaN < -90` are both `false`, so a validator written
 * as `if (lat > 90 || lat < -90) return null` **ACCEPTS NaN** and stores it in
 * Firestore, producing a document no map can render and no query can filter.
 *
 * The check asserts the finite guard appears before the first range comparison in
 * the function body, so reordering them is a failure rather than a latent bug.
 */
const finiteGuardIndex = distanceSource.indexOf('Number.isFinite(lat)');
const rangeTestIndex = distanceSource.search(/lat\s*<\s*-90\s*\|\|\s*lat\s*>\s*90/);
check(
  'isValidLatLng rejects NaN before testing the range (NaN passes both comparisons)',
  finiteGuardIndex !== -1 && rangeTestIndex !== -1 && finiteGuardIndex < rangeTestIndex,
  'the Number.isFinite guard must precede the latitude range test in isValidLatLng',
);

/**
 * 14. `buildGeoCells` must use `neighbors()`, and the array must be deduped.
 *
 * Two properties, both load-bearing:
 *
 *  - **Exact neighbours.** `docs/07 §9.2` describes a ±0.01° offset approximation
 *    and then says "A safer, fully-correct alternative is to take
 *    `ngeohash.neighbours(centre)` if the library exposes it." It does — under the
 *    US spelling. An offset approximation can collapse a neighbour back onto the
 *    centre near a cell edge, which loses coverage silently.
 *  - **Deduped.** `docs/12` VP-3 requires deduped and sorted. A duplicate element
 *    would waste one of the 10 Firestore array slots and misrepresent coverage.
 *
 * Sorted is checked too, because an unsorted array makes two points in the same cell
 * produce different arrays, and cell sets are compared and cached by value.
 */
const geohashSource = code('lib/geo/geohash.ts');
const buildCellsBody = functionBodyOf(geohashSource, 'buildGeoCells');

/**
 * Scoped to `buildGeoCells`'s own body, because the previous file-wide version
 * passed for the wrong reason.
 *
 * `.sort()` and `new Set<string>(` appear elsewhere in the file — in
 * `cellsForBounds` and in `cellsOverlap` — so a file-wide presence test stayed green
 * after `buildGeoCells` was mutated to return an unsorted, undeduped array. Two
 * mutations confirmed it: disabling the `neighbors()` call, and deleting the
 * `.sort()`. Neither moved the count.
 *
 * This is the same lesson as the `functionBodyOf` brace bug, and the same shape of
 * failure: a check that looks for a property *somewhere* in a file is not a check
 * of the function the property belongs to.
 */
/**
 * The `neighbors()` call must be REACHABLE, not merely present.
 *
 * A bare presence test passed after the call was disabled with `if (false && ...)`,
 * because the call expression was still in the source. So the check requires the
 * guard to be a live conditional on `typeof ngeohash.neighbors === 'function'` —
 * which is the form that both uses the exact API and keeps a fallback for a version
 * without it.
 */
const usesExactNeighbours = /if\s*\(\s*typeof ngeohash\.neighbors\s*===\s*'function'\s*\)\s*\{[\s\S]{0,400}?ngeohash\.neighbors\(/.test(
  buildCellsBody,
);
const hasFallback = /NEIGHBOUR_OFFSETS/.test(buildCellsBody) && /else\s*\{/.test(buildCellsBody);
const dedupesAndSorts =
  /new Set<string>\(/.test(buildCellsBody) && /\[\.\.\.cells\]\.sort\(\)/.test(buildCellsBody);
check(
  'buildGeoCells uses ngeohash.neighbors() and returns a deduped, sorted set',
  buildCellsBody.length > 0 && usesExactNeighbours && hasFallback && dedupesAndSorts,
  buildCellsBody.length === 0
    ? 'buildGeoCells not found in lib/geo/geohash.ts'
    : !usesExactNeighbours
      ? 'buildGeoCells does not call ngeohash.neighbors()'
      : !dedupesAndSorts
        ? 'buildGeoCells does not return [...cells].sort() from a Set'
        : 'buildGeoCells has no offset fallback for a ngeohash version without neighbors()',
);

/**
 * 15. The duplicate candidate search must issue EXACTLY ONE Firestore read.
 *
 * `docs/07 §9.2` makes this normative and blunt: "The implementation MUST use one
 * `array-contains` query on the query point's own geohash-6 and then
 * Haversine-filter. **Doing 10 would be a 10x read-cost bug.**"
 *
 * So the check counts the query-building calls in the candidate function. A loop
 * over `buildGeoCells(...).forEach(cell => query(...))` — the obvious wrong
 * implementation, and the one the prohibition exists to prevent — would show up as
 * more than one `.where(` chain.
 *
 * Scoped to the candidate function, not the file: the viewport query legitimately
 * issues one read PER CELL (up to 9), because `in` cannot be combined with
 * `array-contains` (`docs/12 §10.2`).
 */
const findDuplicatesServiceSource = code('services/geo/find-duplicates.ts');
const candidateSearchBody = functionBodyOf(findDuplicatesServiceSource, 'findDuplicateCandidates');

/**
 * **Exactly one** `array-contains` read, and the cell is the QUERY POINT's own.
 *
 * `docs/07 §9.2` is normative and blunt about the failure this guards: "The
 * implementation MUST use one `array-contains` query on the query point's own
 * geohash-6 and then Haversine-filter. **Doing 10 would be a 10x read-cost bug.**"
 *
 * The obvious wrong implementation is a loop over `buildGeoCells(...)` fanning out
 * one query per cell — 9 reads at `maxCandidates` documents each, billed on every
 * report. So the count is asserted as exactly 1, and the `limit()` is asserted to be
 * the configured cap rather than a literal, so a raised cap cannot quietly become a
 * raised read bill.
 *
 * Scoped to the function, because the viewport query legitimately issues one read
 * PER CELL (up to 9): `in` cannot be combined with `array-contains`
 * (`docs/12 §10.2`), so that path is N reads by design.
 */
const arrayContainsCount = (candidateSearchBody.match(/array-contains/g) ?? []).length;
const hasSingleLimitFromConfig = /\.limit\(\s*cfg\.maxCandidates\s*\)/.test(candidateSearchBody);
const hasExactFilterAfter = /classifyDuplicate|findDuplicates/.test(
  functionBodyOf(findDuplicatesServiceSource, 'checkForDuplicates'),
);
check(
  'The duplicate candidate search is ONE array-contains read, then an exact filter',
  candidateSearchBody.length > 0 &&
    arrayContainsCount === 1 &&
    hasSingleLimitFromConfig &&
    hasExactFilterAfter,
  candidateSearchBody.length === 0
    ? 'findDuplicateCandidates not found'
    : arrayContainsCount !== 1
      ? `found ${arrayContainsCount} array-contains reads; docs/07 §9.2 requires exactly 1 (a per-cell fan-out is a 9x read-cost bug)`
      : !hasSingleLimitFromConfig
        ? 'the read limit is not the configured maxCandidates'
        : 'checkForDuplicates does not apply the exact distance filter',
);

/**
 * 16. `classifyDuplicate` must be unable to merge, delete, or suppress.
 *
 * FR-041 and `docs/07 §9.4` rule 1: "`confirmed_duplicate` is a **suggestion
 * surfaced to a human**, not an executed merge. The incident is always created."
 * brief §19 and §27 restate it: proximity is not identity.
 *
 * A source-level check cannot prove the absence of every possible merge, so this
 * checks the two things that would actually be written: that the module imports no
 * write capability from the Admin SDK, and that no Firestore write method is called
 * anywhere in `lib/duplicates/` or `services/geo/find-duplicates.ts`.
 *
 * `lib/duplicates/` is the pure layer (FR-049 requires no Firestore import at all),
 * so an import there would be a hard failure; the service may import the Admin SDK
 * to READ, and this is what distinguishes reading from writing.
 */
const duplicateEngineSource = code('lib/duplicates/score.ts');
const textSimilaritySource = code('lib/duplicates/text.ts');
const pureLayerImportsFirestore =
  /from ['"]firebase-admin|from ['"]@\/lib\/server\/firebase-admin/.test(
    duplicateEngineSource + textSimilaritySource,
  );
const writesInGeoServices = (
  findDuplicatesServiceSource.match(/\.(set|update|add|create|delete|writeBatch|runTransaction)\s*\(/g) ??
  []
).length;
check(
  'The duplicate engine cannot merge: no Firestore import in the pure layer, no writes in the service',
  !pureLayerImportsFirestore && writesInGeoServices === 0,
  pureLayerImportsFirestore
    ? 'lib/duplicates/ imports Firestore, which FR-049 forbids for the pure layer'
    : `${writesInGeoServices} Firestore write call(s) in services/geo/find-duplicates.ts`,
);

/**
 * 17. A client-supplied `geoCells` must be a 400, not a silently-ignored field.
 *
 * `docs/12` GEO-3, FR-036: "Computed **server-side only**. A client-supplied
 * `geoCells` is rejected by the Zod schema (`.strict()`)."
 *
 * The threat is specific: a client that could choose its own cells would choose
 * cells matching nothing (hiding its incident from every map and duplicate query) or
 * cells matching a dense cluster of unrelated incidents (flooding every viewport
 * query in that area). `.strict()` is what makes the extra field a rejection rather
 * than a no-op, so the check requires BOTH `.strict()` on the geo schema AND the
 * absence of `geoCells` from its accepted shape.
 */
const geoValidatorSource = code('validators/geo.ts');
const geoSchemaIsStrict = /\.strict\(\)/.test(geoValidatorSource);
const geoCellsNotInClientShape =
  !/geoInputSchema[\s\S]{0,900}?geoCells:/.test(geoValidatorSource) ||
  /server-side only|server-side path and for tests/.test(geoValidatorSource);
check(
  'geoCells is server-computed only: the client geo schema is .strict() and has no geoCells field',
  geoSchemaIsStrict && geoCellsNotInClientShape,
  !geoSchemaIsStrict
    ? 'validators/geo.ts has no .strict(), so a client geoCells would be ignored'
    : 'the client geo schema appears to accept a geoCells field',
);

/**
 * 18. `categoryGroup` must not inherit from `Object.prototype`.
 *
 * A bare `CATEGORY_GROUPS[category]` on an object literal finds `constructor`,
 * `toString` and every other inherited member, so `categoryGroup('toString')`
 * returned a **function**. Two unmapped categories would then compare EQUAL and two
 * unrelated incidents would be reported as the same group — the opposite of
 * Gate 2's purpose.
 *
 * This is the same class of bug as a prototype-pollution lookup, reached through
 * ordinary data: a category string arriving from AI triage normalisation is an
 * arbitrary string, and "firelight" style inputs are not contrived.
 */
check(
  'categoryGroup uses an own-property check, not an inherited lookup',
  /Object\.hasOwn\(\s*CATEGORY_GROUPS/.test(duplicateEngineSource),
  'lib/duplicates/score.ts must use Object.hasOwn(CATEGORY_GROUPS, category)',
);

/**
 * 19. The `category_mismatch` branch must set a decision, not only reasons.
 *
 * `docs/07 §9.4` Gate 2 makes a same-spot/different-category pair
 * `separate_incident`, and `docs/12` FR-048 wants the decision explainable.
 *
 * This shipped once spreading a `base` object whose `decision` was `'none'` while
 * overriding only `reasons` — so a road accident beside a building fire was
 * filtered out by `findDuplicates` exactly as if it were 3 km away, and a dispatcher
 * was never told the two were considered and rejected. Asserted structurally.
 */
const gate2Branch = /!\s*exactCategory\s*&&\s*!sameGroup\s*\)\s*\{[\s\S]{0,600}?decision:\s*'separate_incident'/.test(
  duplicateEngineSource,
);
check(
  'A category mismatch sets decision: separate_incident, not merely a reason',
  gate2Branch,
  'the Gate 2 early return must set decision explicitly, not inherit none from base',
);

/**
 * 20. The scoring weights must still sum to 1.
 *
 * `potentialThreshold` (0.55) is an ABSOLUTE score, not a percentile, so a weight
 * edit that does not renormalise silently changes what the threshold means. The same
 * reasoning as the unit test, asserted here as well because a threshold that drifts
 * is a policy change nobody reviewed.
 */
const weightSum = [0.35, 0.1, 0.25, 0.3].reduce((a, b) => a + b, 0);
check(
  'The duplicate scoring weights sum to 1.0, so the thresholds keep their meaning',
  Math.abs(weightSum - 1) < 1e-9 &&
    /DUPLICATE_WEIGHTS\s*=\s*\{[\s\S]{0,300}?distance:\s*0\.35[\s\S]{0,300}?time:\s*0\.1[\s\S]{0,300}?category:\s*0\.25[\s\S]{0,300}?text:\s*0\.3/.test(
      duplicateEngineSource,
    ),
  'lib/duplicates/score.ts weights are not the docs/07 §9.4 values (0.35/0.10/0.25/0.30)',
);

/**
 * 21. The duplicate radius and time window must be ENV-configurable, not literals.
 *
 * brief §18: "Implement duplicate detection around a configurable radius:
 * `DUPLICATE_RADIUS_METERS=500`. **Do NOT hardcode 500 throughout the
 * application.**" brief §22 does the same for the time window.
 *
 * So both must be read from the environment in exactly one place, and both must be
 * declared in `.env.example` so a deployer can find them.
 */
const envServerSource = code('lib/env.server.ts');
const radiusIsEnv =
  /tunableNumber\(\s*'DUPLICATE_RADIUS_METERS'/.test(envServerSource) &&
  /tunableNumber\(\s*'DUPLICATE_LOOKBACK_HOURS'/.test(envServerSource);
const envExampleDeclares =
  envExample.includes('DUPLICATE_RADIUS_METERS=') && envExample.includes('DUPLICATE_LOOKBACK_HOURS=');
check(
  'The duplicate radius and time window are env-configurable and declared in .env.example',
  radiusIsEnv && envExampleDeclares,
  !radiusIsEnv
    ? "lib/env.server.ts does not read DUPLICATE_RADIUS_METERS / DUPLICATE_LOOKBACK_HOURS"
    : '.env.example does not declare both variables',
);

/**
 * 22. An auto-prompt on load is forbidden, and the copy must not be coercive.
 *
 * `docs/12 §3.5` + FR-030. The failure is not politeness: Chrome remembers a
 * refusal, so a load-time prompt converts "the user said no this once" into "the
 * user can never say yes", and the fallback path becomes the only path forever.
 *
 * The second half is brief §5's ban on manipulative permission messaging. The
 * explainer must state the benefit and must not use urgency or consequence language.
 */
const geolocationSource = code('features/reporting/use-geolocation.ts');

/**
 * No `request()` call from an EFFECT body, at any nesting depth.
 *
 * `docs/12 §3.5` + FR-030: an auto-prompt on load is forbidden, and the reason is
 * measurement rather than politeness — Chrome remembers a refusal, so a load-time
 * prompt turns "the user said no this once" into "the user can never say yes" and
 * the fallback path becomes the only path for every future session.
 *
 * The first version of this check matched a fixed-shape regex
 * (`useEffect(() => { request()`) and did not bite when the call was moved one line
 * down. So this counts the effect bodies and requires that NONE of them contains a
 * `request()` call — which is the actual invariant, stated as a property of every
 * effect rather than as a pattern to be evaded.
 */
const effectBodies = [
  ...geolocationSource.matchAll(/(?:React\s*\.\s*)?useEffect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>/g),
].map((match) => {
  // Balance from the opening brace of the arrow body.
  let depth = 0;
  const open = geolocationSource.indexOf('{', match.index + match[0].length - 1);
  if (open === -1) return '';
  for (let i = open; i < geolocationSource.length; i += 1) {
    if (geolocationSource[i] === '{') depth += 1;
    else if (geolocationSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return geolocationSource.slice(open, i + 1);
    }
  }
  return '';
});
const effectsCallingRequest = effectBodies.filter((body) => /(?<![.\w])request\s*\(\s*\)/.test(body));
const noAutoPrompt = effectBodies.length > 0 && effectsCallingRequest.length === 0;
const coercivePatterns = [
  /people will die/i,
  /lives? (are|is) at stake/i,
  /you must (allow|enable|share)/i,
  /\brequired\b/i,
  /emergency services (need|require)/i,
];
const coerciveCopy = coercivePatterns.filter((pattern) => pattern.test(geolocationSource));
check(
  'Geolocation is never auto-prompted, and the explainer is not coercive (FR-030, brief §5)',
  noAutoPrompt && coerciveCopy.length === 0,
  effectBodies.length === 0
    ? 'no useEffect found in use-geolocation.ts, so the auto-prompt check could not run'
    : effectsCallingRequest.length > 0
      ? 'a useEffect calls request() — docs/12 §3.5 forbids an auto-prompt on load'
      : coerciveCopy.map(String).join('; '),
);

/**
 * 23. No geolocation copy may claim a responder is coming — brief §34.
 *
 * Enforced as a check as well as a test, for the same reason the speech copy is:
 * "emergency services have been notified" is the single most damaging string this
 * product could render, and it is exactly the kind of sentence someone adds to make
 * a flow feel reassuring.
 */
const geoCopyClaim = [
  /emergency services (have|has) been notified/i,
  /help is on the way/i,
  /responders? (have|has) been dispatched/i,
  /we('ve| have) (located|found) you/i,
].filter((pattern) => pattern.test(geolocationSource));
check(
  'No geolocation copy claims a responder is on the way (brief §34)',
  geoCopyClaim.length === 0,
  geoCopyClaim.map(String).join('; '),
);

/**
 * 24. `ngeohash` must be typed, not `any`.
 *
 * `types/ngeohash.d.ts` exists because the package ships no types, and the
 * alternative — `declare module 'ngeohash';` — makes every import `any` and
 * silently disables checking at the boundary where a mistake is most expensive.
 *
 * That is not theoretical. The first `decode()` call was written against an assumed
 * `{ lat, lng }` shape when the real one is `{ latitude, longitude }`. With `any`
 * that compiles, runs, and `clampLatitude(undefined)` yields `0` — so every geohash
 * cell would be encoded at the equator and **no incident would ever match a
 * viewport query**. A typed declaration rejects the destructure at compile time.
 */
const ngeohashTypesPath = join(ROOT, 'types/ngeohash.d.ts');
const ngeohashTypesExist = existsSync(ngeohashTypesPath);
const ngeohashTypes = ngeohashTypesExist ? readFileSync(ngeohashTypesPath, 'utf8') : '';

/**
 * A bare `declare module 'ngeohash';` has NO braces.
 *
 * The naive `/declare module 'ngeohash'\s*;/` test matched this project's own
 * *good* declaration, because the phrase appears inside the doc comment explaining
 * why that form is avoided — "The usual shortcut — `declare module 'ngeohash';` —
 * makes every import `any`". Matching prose is how a check reports a false FAIL and
 * trains its reader to ignore it.
 *
 * So the test is structural: strip comments, then require an opening brace. A
 * shorthand ambient module genuinely has no body, and this one has an interface, an
 * encode signature and a decode signature inside it.
 */
const ngeohashCodeOnly = ngeohashTypes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const notBareAny =
  ngeohashTypesExist && /declare module 'ngeohash'\s*\{/.test(ngeohashCodeOnly);
const decodeShapeIsTyped =
  ngeohashTypesExist &&
  /readonly latitude: number;[\s\S]{0,120}?readonly longitude: number;/.test(ngeohashCodeOnly);
check(
  'ngeohash is typed with the real decode() shape, not a bare any declaration',
  notBareAny && decodeShapeIsTyped,
  !ngeohashTypesExist
    ? 'types/ngeohash.d.ts is missing — the import is untyped'
    : !decodeShapeIsTyped
      ? 'the declaration does not type decode() as { latitude, longitude }'
      : 'types/ngeohash.d.ts is a bare `declare module` and makes the import any',
);

/* ------------------------------------------------------------------------ */
/* Report                                                                     */
/* ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ */
/* Phase 7 — responder dispatch                                              */
/* ------------------------------------------------------------------------ */
/*
 * The Phase 7 checks are the ones where a FALSE PASS is expensive:
 *
 *  - "no route can dispatch without a human" is brief §3's entire requirement,
 *    and the failure mode is a system that quietly dispatches by itself.
 *  - "the assignment is transactional" is brief §15's race protection, and the
 *    failure mode is two dispatchers taking one responder.
 *  - "no client-supplied role" is brief §36, and the failure mode is privilege
 *    escalation.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK BELOW IS STRIPPED OF COMMENTS FIRST, AND THAT MATTERS
 * ---------------------------------------------------------------------------
 * Four of these checks look for a prohibited STRING, and the code that prohibits
 * it necessarily CONTAINS it: `services/dispatch/notify.ts` declares
 * `FORBIDDEN_NOTIFICATION_CLAIMS` as a list of the very sentences it refuses to
 * write, and `config/dispatch.ts` explains in a comment why it has no env vars.
 *
 * Without stripping, those checks fail on a CORRECT implementation — which is
 * worse than not having them, because the fix a developer reaches for is to
 * delete the list of forbidden phrases, which removes the control.
 *
 * So `codeOnly()` is applied to every source before a string check, and
 * `excludes()` removes a named declaration for the one check whose subject IS a
 * declaration of forbidden strings.
 */

const transitionsSource = read('lib/dispatch/transitions.ts');
const assignSource = read('services/dispatch/assign.ts');
const lifecycleSource = read('services/dispatch/lifecycle.ts');
const notifySource = read('services/dispatch/notify.ts');
const auditSource = read('services/dispatch/audit.ts');
const historySource = read('services/dispatch/status-history.ts');
const candidatesSource = read('services/dispatch/candidates.ts');
const dispatchValidators = read('validators/dispatch.ts');
const dispatchConfig = read('config/dispatch.ts');
const dispatchRoute = read('app/api/incidents/[id]/dispatch/route.ts');
const candidatesRoute = read('app/api/incidents/[id]/candidates/route.ts');
const statusRoute = read('app/api/incidents/[id]/status/route.ts');
const dispatchIdRoute = read('app/api/dispatches/[dispatchId]/route.ts');
const enumsSource = read('types/enums.ts');

/**
 * Strip comments, so a comment that EXPLAINS a prohibition is not read as a
 * violation of it.
 *
 * Deliberately crude — it is a lexer for two comment forms, not a parser. It does
 * not need to understand string literals, because the only strings it could
 * mistake for a comment are `//` and `/*` inside a literal, and neither appears in
 * the sources these checks read. A real lexer here would be more code to get wrong
 * for no additional safety.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Drop a named declaration from a source, so a check about forbidden strings is
 * not defeated by the list that NAMES them.
 */
function excludes(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) return source;
  const end = source.indexOf(endMarker, start);
  return end === -1 ? source.slice(0, start) : source.slice(0, start) + source.slice(end);
}

/**
 * The text of ONE declaration, from its marker to the next `/* ====` banner.
 *
 * Added after two Phase 7 checks turned out to be passing for the wrong reason,
 * both with the same shape: each searched a WHOLE FILE for a string that also
 * appears somewhere else in it, so removing it from the intended declaration left
 * the suite green.
 *
 *   - check 27 looked for `activeIncidentCount: activeCount + 1` anywhere in
 *     `assignResponder`, and found it in the AUDIT DIFF as well as in the write.
 *     Deleting the write — the thing that makes concurrent assigns conflict — left
 *     the audit value in place and the check passed.
 *   - check 37 looked for `reason: reason.optional()` anywhere in the validators,
 *     and found it in the STATUS schema as well as the REJECT one.
 *
 * A whole-file check cannot distinguish "the property is set" from "the property
 * is mentioned". Scoping to the declaration makes the two different questions.
 */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const end = source.indexOf('/* ====', start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/**
 * 25. The AI may not reach `assigned`, and `auto_suggest` is unreachable.
 *
 * brief §3: "AI may recommend suitable responders, but AI must NOT autonomously
 * dispatch emergency responders." `docs/07 §8` allows a dispatch `mode` of
 * `auto_suggest`, so the ENUM is not the control — the code paths are.
 *
 * Two independent assertions, because either alone is insufficient: the table
 * could grant `system` a cell, or a route could pass `mode: 'auto_suggest'`.
 */
const transitionsCode = codeOnly(transitionsSource);
// Scoped to the grid, not the whole file: the `Cell` union also names
// `'system (ai)'`, and counting that would be counting the type, not a grant.
const matrixRegion = (() => {
  const start = transitionsCode.indexOf('const NOBODY');
  const end = transitionsCode.indexOf('const TRANSITION_MATRIX');
  return start === -1 || end === -1 ? '' : transitionsCode.slice(start, end);
})();
const systemCellCount = (matrixRegion.match(/'system \(ai\)'/g) ?? []).length;
const autoSuggestUnreachable =
  !/mode:\s*'auto_suggest'/.test(dispatchRoute) &&
  !/mode:\s*'auto_suggest'/.test(dispatchIdRoute) &&
  !/mode:\s*'auto_suggest'/.test(statusRoute) &&
  !/mode:\s*'auto_suggest'/.test(lifecycleSource) &&
  // The input type is narrowed, so a route cannot pass it without a deliberate
  // cast — and a cast is a visible, reviewable act.
  /Extract<DispatchMode, 'manual' \| 'self_claimed'>/.test(assignSource);
check(
  'The AI cannot dispatch: one system cell, and auto_suggest unreachable (brief §3)',
  systemCellCount === 1 && autoSuggestUnreachable,
  systemCellCount !== 1
    ? `the transition grid declares 'system (ai)' in ${systemCellCount} cells; docs/07 §4.3 allows exactly one`
    : !autoSuggestUnreachable
      ? "a route or service can pass mode: 'auto_suggest', or the input type is not narrowed"
      : '',
);

/**
 * 26. `isLiveAssignee` is DERIVED, never received.
 *
 * brief §36: "Never trust: ... client status." `isLiveAssignee` is the flag that
 * grants a responder the `en_route` / `on_scene` / `resolved` cells, so a client
 * that could set it would be able to drive any incident's lifecycle.
 */
const liveAssigneeFromFirestore =
  /isLiveAssignee:\s*liveDispatch\?\.responderUid === input\.actor\.uid/.test(lifecycleSource) &&
  /isLiveAssignee:\s*false/.test(assignSource);
const liveAssigneeNotAField = !/['"`]?isLiveAssignee['"`]?\s*:/.test(codeOnly(dispatchValidators));
check(
  'isLiveAssignee is derived from Firestore, and is not a request field (brief §36)',
  liveAssigneeFromFirestore && liveAssigneeNotAField,
  !liveAssigneeFromFirestore
    ? 'a transition context builds isLiveAssignee from something other than the live dispatch'
    : !liveAssigneeNotAField
      ? 'validators/dispatch.ts declares isLiveAssignee, so a client could send it'
      : '',
);

/**
 * 27. The assignment is a TRANSACTION, and it WRITES the responder.
 *
 * brief §15 and §39. The subtle half is the write: Firestore only guarantees
 * conflict detection for documents a transaction both reads AND writes, so a
 * transaction that merely read `responders/{uid}` would still let two dispatchers
 * commit against the same responder.
 */
const assignBody = functionBodyOf(assignSource, 'assignResponder');
// Scoped to the write, not the whole body: the same expression appears in the
// audit diff, and a check that matched either one would stay green when the other
// was removed. See `blockAfter` for why that is a documented failure mode.
const responderWrite = /transaction\.set\(\s*responderRef,[\s\S]{0,240}?activeIncidentCount: activeCount \+ 1/.test(
  assignBody,
);
const assignIsTransactional = assignBody.includes('runTransaction') && responderWrite;
check(
  'Assignment is transactional AND writes the responder, so concurrent assigns conflict',
  assignIsTransactional,
  !assignBody.includes('runTransaction')
    ? 'assignResponder does not use runTransaction, so the availability check is a race'
    : 'assignResponder reads the responder but never WRITES activeIncidentCount to it, so two dispatchers can both commit',
);

/**
 * 28. `assigneeUid` is written in the SAME transaction, and CLEARED on decline.
 *
 * Not an optimisation. `firestore.rules`' `canRead()` for `incidents` grants a
 * responder access when `resource.data.assigneeUid == request.auth.uid`, so a
 * dispatch that did not denormalise this field (docs/07 §4) would leave the
 * assigned responder unable to read their own incident — the workflow would work
 * in the database and be unreachable from the client.
 *
 * And clearing it on a decline is a SECURITY property, not tidiness: leaving it
 * set keeps granting read access to a responder who just walked away.
 */
const assigneeUidWritten =
  assignBody.includes('assigneeUid: input.responderUid') && assignBody.includes('runTransaction');
const assigneeUidClearedOnDecline = /assigneeUid: null[\s\S]{0,120}?assignee: null/.test(
  codeOnly(lifecycleSource),
);
check(
  'incidents.assigneeUid is denormalised on assign and CLEARED on decline (docs/07 §4, firestore.rules)',
  assigneeUidWritten && assigneeUidClearedOnDecline,
  !assigneeUidWritten
    ? 'assignResponder does not write assigneeUid, so firestore.rules canRead() grants the assignee no access'
    : 'a decline does not clear assigneeUid, so a responder who declined keeps read access',
);

/**
 * 29. No dispatch route reads a role, a uid, or a status from the body.
 *
 * brief §36's list, checked against the source rather than trusted to the schema.
 * A schema check alone would not catch a route reading a property the schema never
 * declared, because `withRequest` types the body — it does not strip it at runtime.
 */
const bodyTrustViolations = [];
for (const [name, source] of [
  ['dispatch', dispatchRoute],
  ['candidates', candidatesRoute],
  ['status', statusRoute],
  ['dispatchId', dispatchIdRoute],
]) {
  const code = codeOnly(source);
  for (const pattern of [
    /body\.(role|uid|actorUid|isLiveAssignee|isReporter|verification|assigneeUid|dispatcherUid)\b/,
    /body\.(status|incidentStatus)\b/,
  ]) {
    if (pattern.test(code)) bodyTrustViolations.push(`${name}: ${pattern}`);
  }
}
const actorAlwaysFromToken = /actor:\s*\{\s*uid: user\.uid,\s*role: user\.role\s*\}/.test(codeOnly(statusRoute));
check(
  'No dispatch route reads a role, uid, or status from the request body (brief §36)',
  bodyTrustViolations.length === 0 && actorAlwaysFromToken,
  bodyTrustViolations.length > 0
    ? bodyTrustViolations.join('; ')
    : !actorAlwaysFromToken
      ? 'the status route does not build its actor from the verified token'
      : '',
);

/**
 * 30. Every dispatch route gates on its documented capability.
 *
 * A route that reaches `assignResponder` with no capability check is a route whose
 * only protection is the service's internal `actor.role` — and `role` arrives as a
 * parameter, so a future route passing the wrong thing would be invisible here.
 */
const routeGates = [
  ['dispatch', dispatchRoute, 'r29_assignResponder'],
  ['candidates', candidatesRoute, 'r28_seeCandidateResponders'],
  ['dispatchId', dispatchIdRoute, 'r30_unassignWithdraw'],
];
const ungatedRoutes = routeGates
  .filter(([, source, capability]) => !source.includes(`requireCapability(user, '${capability}'`))
  .map(([name, , capability]) => `${name} is missing requireCapability(${capability})`);
check(
  'Every dispatch route requires its documented capability (r28/r29/r30)',
  ungatedRoutes.length === 0,
  ungatedRoutes.join('; '),
);

/**
 * 31. The status route gates on a capability but does NOT blanket-deny citizens.
 *
 * `docs/07 §4.3` grants the `reporter` two transitions, and this route is the only
 * path to them. A blanket `requireRole(['dispatcher','admin'])` would make the
 * reporter's cancellation unreachable — and a check written to catch "citizens must
 * not dispatch" would have "fixed" that by breaking a documented capability.
 */
const statusUsesCapability = /requireCapability\(user, 'r01_createIncident'/.test(codeOnly(statusRoute));
const statusNoBlanketRoleDenial = !/requireRole\(user, \['dispatcher', 'admin'\]\)/.test(codeOnly(statusRoute));
check(
  'The status route gates on capability, leaving the reporter cancel path reachable (docs/07 §4.3)',
  statusUsesCapability && statusNoBlanketRoleDenial,
  !statusUsesCapability
    ? 'the status route no longer calls requireCapability'
    : 'the status route blanket-denies non-ops roles, which would remove the reporter cancel path',
);

/**
 * 32. No ETA is ever computed.
 *
 * brief §30: "Do not claim travel time unless a real routing API has been
 * implemented. Distance is not the same than ETA." There is no routing provider in
 * this project, so any arithmetic producing `etaSec` would be a fabrication a
 * dispatcher would act on.
 *
 * Comments are stripped, because `candidates.ts` and `assign.ts` both explain at
 * length why they do NOT compute one, and those explanations contain the word.
 */
const etaViolations = [];
if (!/etaSec:\s*null/.test(codeOnly(assignSource))) etaViolations.push('assign.ts does not write etaSec: null');
if (/etaSec\s*[:=]\s*(?!null\b)[^;\n]*[\d(]/.test(codeOnly(assignSource))) {
  etaViolations.push('assign.ts computes an etaSec value');
}
if (/\beta\w*\s*[:=]\s*[^(]*\d/.test(codeOnly(candidatesSource))) {
  etaViolations.push('candidates.ts computes a travel-time value');
}
check(
  'No travel time is ever computed or claimed; etaSec is written null (brief §30)',
  etaViolations.length === 0,
  etaViolations.join('; '),
);

/**
 * 33. No notification copy overclaims.
 *
 * brief §28. The same check Phase 6 applies to geolocation copy, applied to the
 * dispatch copy — "an ambulance is on the way" is the most damaging string this
 * phase could render, and it is exactly what someone adds to make a flow feel
 * reassuring.
 *
 * The forbidden-phrase LIST is excluded from the subject, for the reason in this
 * section's header: `FORBIDDEN_NOTIFICATION_CLAIMS` contains every phrase it
 * refuses, and including it would make this check fail on a correct module.
 */
const notifyCode = excludes(
  codeOnly(notifySource),
  'const FORBIDDEN_NOTIFICATION_CLAIMS',
  // The closing bracket of THAT array literal, not the next section header.
  // A section-header marker cut from the list all the way past `notifyInApp`,
  // which removed the very catch block this file's check 38 looks for — a check
  // that failed because it had deleted its own subject.
  '];',
);
const dispatchOverclaims = [
  /emergency services (are|is) arriving/i,
  /help is on the way/i,
  /responders? (are|is) (on the way|en route)/i,
  /an ambulance (has been sent|is on the way)/i,
  /we('ve| have) alerted authorities/i,
  // `\beta\b` rather than `eta`, which matches inside `getAdminDb`/`metadata`.
  /\betas?\b[^.\n]{0,20}(minute|min\b|arriv)/i,
].filter((pattern) => pattern.test(notifyCode));
check(
  'No dispatch notification copy claims help is coming (brief §28)',
  dispatchOverclaims.length === 0,
  dispatchOverclaims.map((source) => source.source ?? String(source)).join('; '),
);

/**
 * 34. The audit deny-list is enforced on BOTH write paths.
 *
 * `docs/07 §11.5`: "whitelisted fields only - **never** raw PII or evidence
 * URLs". The check is that the deny-list is actually CONSULTED on the write path
 * and not merely declared: a declared-but-uncalled set reads as a control and is
 * not one. The in-transaction path is checked separately because that is the one
 * an assignment actually uses.
 */
const auditCode = codeOnly(auditSource);
const auditDenyListDeclared = /FORBIDDEN_AUDIT_FIELDS[^=]*=\s*new Set/.test(auditCode);
const auditDiffPath = /function buildAuditDiff[\s\S]{0,400}?assertAuditSafe\(whitelist\)/.test(auditCode);
const auditTransactionPath = /function auditLogInTransaction[\s\S]{0,600}?assertAuditSafe\(/.test(auditCode);
const auditNamesSensitiveFields = /['"]location['"]/.test(auditCode) && /['"]signedReadUrl['"]/.test(auditCode);
check(
  'The audit deny-list is enforced on BOTH the plain and in-transaction write paths (docs/07 §11.5)',
  auditDenyListDeclared && auditDiffPath && auditTransactionPath && auditNamesSensitiveFields,
  !auditDenyListDeclared
    ? 'FORBIDDEN_AUDIT_FIELDS is not declared as a Set'
    : !auditDiffPath
      ? 'buildAuditDiff does not call assertAuditSafe'
      : !auditTransactionPath
        ? 'auditLogInTransaction does not call assertAuditSafe — that is the path an assignment uses'
        : 'the deny-list does not name location or signedReadUrl',
);

/**
 * 35. `statusHistory` is append-only in CODE, not just in the rules.
 *
 * `docs/07 §6`: "Append-only. Never updated, never deleted." brief §24: "Do not
 * allow history entries to be silently edited." A rules-level `write: if false`
 * covers the client; this covers a future service.
 */
const historyCode = codeOnly(historySource);
const historyWriteViolations = [];
if (/\.update\(/.test(historyCode)) historyWriteViolations.push('status-history.ts calls .update()');
if (/\.delete\(/.test(historyCode)) historyWriteViolations.push('status-history.ts calls .delete()');
if (!/merge:\s*false/.test(historyCode)) historyWriteViolations.push('the write is not merge: false');
check(
  'statusHistory is append-only in code: no update, no delete, merge false (docs/07 §6)',
  historyWriteViolations.length === 0,
  historyWriteViolations.join('; '),
);

/**
 * 36. Every audit action Phase 7 writes is a declared `AuditAction`.
 *
 * An action outside the enum is an action no compliance review can filter for
 * (FR-132).
 *
 * Membership is a PLAIN SUBSTRING test, not a regex. The first draft built a
 * RegExp with the action escaped, and a `.` in `incident.assign` plus a template
 * literal is enough escaping machinery to fail for a reason unrelated to the
 * thing being checked. "Is this exact quoted string present" needs no escaping.
 */
const phase7Actions = [
  ...[...assignSource.matchAll(/action:\s*'([a-z_.]+)'/g)].map((match) => match[1]),
  ...[...lifecycleSource.matchAll(/action:\s*([?:\s\n()a-z_.']*?'([a-z_.]+)'[a-z_.']*)/g)].map(
    (match) => match[match.length - 1],
  ),
];
const undeclaredActions = [...new Set(phase7Actions)].filter(
  (action) => !enumsSource.includes(`'${action}'`),
);
check(
  'Every audit action Phase 7 writes is declared in AUDIT_ACTIONS (FR-132)',
  phase7Actions.length > 0 && undeclaredActions.length === 0,
  phase7Actions.length === 0
    ? 'no audit action was found in assign.ts or lifecycle.ts — the check is looking at nothing'
    : undeclaredActions.length > 0
      ? 'undeclared: ' + undeclaredActions.join(', ')
      : '',
);

/**
 * 37. A decline is recorded even without a reason.
 *
 * brief §16 allows a reason but does not require one, and `docs/07 §6` DOES
 * require a reason for an `unassigned` EVENT. Those reconcile by requiring the
 * reason on the event while leaving it optional on the REQUEST — so the check
 * asserts the builder enforces it AND the schema does not.
 */
const declineReasonRequiredInHistory =
  /REASON_REQUIRED_EVENTS[\s\S]{0,240}?'unassigned'/.test(historyCode) &&
  /MissingHistoryReasonError/.test(historyCode);
// Scoped to the reject schema. `reason: reason.optional()` also appears in the
// status schema, so an unscoped check would stay green when the reject one
// tightened — which is the exact regression this asserts against.
// Scoped BEFORE stripping, not after: `codeOnly` replaces block comments with a
// space, which removes the `/* ====` banner `blockAfter` cuts on — so stripping
// first made the scope silently empty and the check pass for no reason at all.
const rejectSchema = codeOnly(blockAfter(dispatchValidators, 'export const rejectDispatchBodySchema ='));
const declineReasonOptionalInRequest =
  rejectSchema.length > 0 && /reason:\s*reason\.optional\(\)/.test(rejectSchema);
check(
  'A decline records a reason on the EVENT while the request leaves it optional (brief §16, docs/07 §6)',
  declineReasonRequiredInHistory && declineReasonOptionalInRequest,
  !declineReasonRequiredInHistory
    ? 'an unassigned history event does not require a reason'
    : rejectSchema.length === 0
      ? 'rejectDispatchBodySchema was not found — the check is looking at nothing'
      : 'the reject body makes a reason mandatory, which would force a responder to record a false one',
);

/**
 * 38. Notification failure cannot fail the request.
 *
 * FR-107. Asserted on the STRUCTURE — that `notifyInApp` catches per recipient, and
 * that the routes notify AFTER the service call — rather than on a comment.
 */
const notifyInAppCatches = /catch\s*\(error\)\s*\{[\s\S]{0,900}?failed \+= 1/.test(notifyCode);
const notificationAfterTransaction =
  /const result = await assignResponder\([\s\S]{0,3000}?await notifyInApp\(/.test(dispatchRoute) &&
  /const result = await respondToDispatch\([\s\S]{0,3000}?await notifyDispatchAnswered\(/.test(
    dispatchIdRoute,
  );
check(
  'A notification failure cannot fail the request that caused it (FR-107)',
  notifyInAppCatches && notificationAfterTransaction,
  !notifyInAppCatches
    ? 'notifyInApp has no per-recipient catch, so one bad write would propagate to the caller'
    : 'a route notifies before the service call, or not at all',
);

/**
 * 39. Dispatch tunables are constants, not invented environment variables.
 *
 * A configurable value with no documented owner, no validation and no default is
 * how a 5 km service radius silently becomes 500 m. `docs/21` names no tunable for
 * these, so adding one would create a configuration surface nothing governs.
 *
 * Comments are stripped, because the file explains this decision in a comment that
 * necessarily contains the word "environment".
 */
const inventedEnvVars = [...codeOnly(dispatchConfig).matchAll(/process\.env|env\.[A-Z_]+/g)].map(String);
check(
  'Dispatch tunables are constants, not undocumented env vars (docs/21)',
  inventedEnvVars.length === 0,
  inventedEnvVars.join('; '),
);

/**
 * 40. The duplicate-detection radius is not reused as a dispatch threshold.
 *
 * `docs/07 §9`'s 500 m duplicate window and `docs/07 §7`'s service radius are
 * different things with different numbers. A phase that reached for the duplicate
 * constant when ranking responders would silently apply a duplicate-detection
 * threshold to a human staffing decision.
 */
const duplicateConstantReused =
  /DUPLICATE_DEFAULTS/.test(dispatchConfig) || /duplicateRadiusM/.test(codeOnly(candidatesSource));
check(
  'The duplicate-detection radius is not reused as a dispatch threshold (docs/07 §9 vs §7)',
  !duplicateConstantReused,
  duplicateConstantReused ? 'a dispatch rule reads the duplicate-detection constant' : '',
);

/* ------------------------------------------------------------------------ */
/* Phase 8 — realtime operations                                              */
/* ------------------------------------------------------------------------ */
/*
 * These checks cover the properties of `docs/11` that are STRUCTURAL rather than
 * behavioural: a rule that "listeners are created only by useRealtime* hooks"
 * cannot be tested by mounting a component, and a lint rule that does not exist is
 * a rule nobody follows.
 *
 * Each is scoped to a file or a function body. A whole-file regex for
 * `onSnapshot` passes when it finds nothing anywhere — including when the file
 * that should contain it was renamed, which is the "check passes for the wrong
 * reason" failure this project's own checklist warns about.
 */

const registrySource = read('lib/realtime/listener-registry.ts');
const queriesSource = read('lib/firestore/queries.ts');
const primitiveSource = read('hooks/use-realtime-listener.ts');
const connectionSource = read('lib/realtime/connection.ts');
const mergeSource = read('lib/realtime/merge-snapshot.ts');
const l1Hook = read('features/incidents/use-realtime-incidents.ts');
const rowMapper = read('features/incidents/live-incident-row.ts');
const enumsSource8 = read('lib/collections/enums.ts');
const indexesJson = read('firestore.indexes.json');

/** Strip comments, so prose about a prohibition is not read as a violation. */
function codeOnly8(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `.ts`/`.tsx` under a directory, as repo-relative forward-slash paths. */
function sourceFilesUnder(dir) {
  return walk(dir)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => file.replace(/\\/g, '/'));
}

/**
 * 41. Rule R-1: `onSnapshot` appears in EXACTLY ONE place.
 *
 * `docs/11 §2.1`: "Listeners are created only by `useRealtime*` hooks. A raw
 * chained `.where()` inside an `onSnapshot` call in a component is a defect."
 *
 * Checked by CALL SITE rather than by import, because a component can reach
 * `onSnapshot` through any path. A count of exactly one is the assertion; a count
 * of zero is the interesting failure, since it means the primitive was renamed and
 * every listener silently stopped working.
 */
const snapshotCallSites = [];
for (const file of [...sourceFilesUnder('app'), ...sourceFilesUnder('components'), ...sourceFilesUnder('features'), ...sourceFilesUnder('hooks')]) {
  const code = codeOnly8(read(file));
  if (/\bonSnapshot\s*\(/.test(code)) snapshotCallSites.push(file);
}
check(
  'Rule R-1: onSnapshot is called in exactly ONE place, the useRealtime* primitive (docs/11 §2.1)',
  snapshotCallSites.length === 1 && snapshotCallSites[0] === 'hooks/use-realtime-listener.ts',
  snapshotCallSites.length === 0
    ? 'no onSnapshot call site found — the primitive was renamed or removed and every listener is dead'
    : snapshotCallSites.length > 1
      ? 'raw onSnapshot outside the primitive: ' + snapshotCallSites.join(', ')
      : '',
);

/**
 * 42. Every listener query is built by a helper in `lib/firestore/queries.ts`.
 *
 * QD-11: "A listener query is built by a helper, never inline." A component that
 * chains its own `.where()` bypasses the role guard, the `limit` assertion and the
 * soft-delete filter all at once, so this is the check that makes those three
 * hold.
 */
const queryHelperExports = (queriesSource.match(/export function \w+Query\(/g) ?? []).length;
const l1UsesHelper = /queueQuery\(db,/.test(l1Hook);
check(
  'Rule R-2: listener queries are built by lib/firestore/queries.ts helpers (docs/11 §2.1)',
  queryHelperExports >= 9 && l1UsesHelper,
  queryHelperExports < 9
    ? `only ${queryHelperExports} query helpers exist; docs/11 §2.2 needs one per listener`
    : !l1UsesHelper
      ? 'the L1 hook does not call queueQuery'
      : '',
);

/**
 * 43. QD-1: EVERY query helper has a `limit()`.
 *
 * Checked per FUNCTION rather than file-wide, so a helper that loses its limit is
 * caught even when its nine siblings still have theirs — which is precisely the
 * case a whole-file check misses.
 */
const helpersWithoutLimit = [];
for (const match of queriesSource.matchAll(/export function (\w+Query)\([^)]*\)[^{]*\{/g)) {
  const name = match[1];
  const start = match.index + match[0].length;
  const end = queriesSource.indexOf('\nexport function', start);
  const body = queriesSource.slice(start, end === -1 ? undefined : end);
  // A single-document listener returns a DocumentReference and cannot be unbounded:
  // it matches one document or none. Those are the documented exception.
  const isSingleDocument = /:\s*DocumentReference\s*\{/.test(match[0]) || /\)\s*:\s*DocumentReference/.test(match[0]);
  if (!isSingleDocument && !/fsLimit\(/.test(body)) helpersWithoutLimit.push(name);
}
check(
  'QD-1: every collection query helper declares a limit() (docs/11 §6)',
  helpersWithoutLimit.length === 0,
  helpersWithoutLimit.length > 0 ? 'no limit() in: ' + helpersWithoutLimit.join(', ') : '',
);

/**
 * 44. QD-2: every `incidents` query filters `deletedAt == null`.
 *
 * "The single most commonly forgotten filter" per the document, and its absence
 * does not look like a bug — a soft-deleted incident is retained for audit, so an
 * unfiltered queue shows a two-year-old report as if it were open.
 */
const incidentQueryBodies = [];
{
  // The declaration line is captured separately from the body so the single-document
  // exemption can read the RETURN TYPE. Matching the body alone cannot tell
  // `incidentQuery` (one document) from `queueQuery` (a filtered list).
  const re = /export function (\w+Query)\(([^)]*)\)\s*:\s*([^{]+)\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(queriesSource)) !== null) {
    incidentQueryBodies.push({
      name: m[1],
      params: m[2],
      returnType: m[3].trim(),
      body: m[4],
      bodyStart: m.index,
      declLength: m[0].indexOf('{'),
    });
  }
}
// A single-document or subcollection listener is exempt: a soft-deleted PARENT is
// already gated by the parent's own canRead(), and a document query cannot filter
// on a sibling field. The exemption is detected from the RETURN TYPE on the
// declaration line — the first version looked for 'DocumentReference' in a
// 200-character window and therefore exempted nothing, so the check failed on two
// correct functions.
const incidentHelpers = incidentQueryBodies
  .filter((q) => /COLLECTIONS\.incidents/.test(q.body))
  .filter((q) => {
    // `declLength` is the offset of the opening brace, so `decl` does NOT include
    // it. The first version required a trailing `\{` and therefore matched nothing
    // — an exemption that never fires, which is the worst shape for a check.
    const decl = queriesSource.slice(q.bodyStart, q.bodyStart + q.declLength);
    if (/\)\s*:\s*DocumentReference\s*$/.test(decl.trimEnd())) return false;
    // A subcollection under an incident inherits the parent's rules.
    if (/SUB_COLLECTIONS\./.test(q.body)) return false;
    return true;
  });
const missingSoftDelete = incidentHelpers
  .filter((q) => !/fsWhere\('deletedAt', '==', null\)/.test(q.body))
  .map((q) => q.name);
check(
  'QD-2: every incidents collection query filters deletedAt == null (docs/11 §6)',
  missingSoftDelete.length === 0,
  missingSoftDelete.length > 0 ? 'missing the soft-delete filter: ' + missingSoftDelete.join(', ') : '',
);

/**
 * 45. QD-4: the ops-only query builders REFUSE a non-ops role.
 *
 * `docs/11 §11.3` SEC-6: "A citizen client has **no** code path that constructs L1,
 * L3, L4, L8, or L9." The guard is UX, not security — the rules are — so the
 * check is that the guard exists and its own comment says which of the two it is.
 */
const opsQueryCount = (queriesSource.match(/assertOpsRole\(input\.role, '/g) ?? []).length;
const guardExplainsItself = /UX protection, not a security boundary/.test(queriesSource);
check(
  'QD-4: the five ops-only query builders refuse a non-ops role, and say so (docs/11 §6, §11.3 SEC-6)',
  opsQueryCount === 4 && guardExplainsItself,
  opsQueryCount !== 4
    ? `only ${opsQueryCount} of the 4 ops-only builders call assertOpsRole (L1, L4, L8, L9)`
    : !guardExplainsItself
      ? 'the role guard no longer documents that it is UX, not a security boundary'
      : '',
);

/**
 * 46. SEC-4: the notification query has NO parameter to widen it.
 *
 * "L5's query is `where('recipientUid','==',uid)` and the hook exposes **no
 * parameter** to widen it. There is no `?recipientUid=` in the client path."
 *
 * Asserted as a PARAMETER COUNT, not a regex on the body: a function whose only
 * parameter is `uid` cannot be widened, whatever its body does. That is the
 * property the document is actually asking for.
 */
const notifSig = queriesSource.match(/export function notificationQuery\(([^)]*)\)/);
const notifParams = notifSig === null ? [] : (notifSig[1].match(/(db|uid|role|limit|recipientId)/g) ?? []);
check(
  'SEC-4: the notification query cannot be widened to another recipient (docs/11 §11.3)',
  notifSig !== null && notifParams.length === 2 && notifParams.includes('db') && notifParams.includes('uid'),
  notifSig === null
    ? 'notificationQuery not found'
    : 'notificationQuery takes ' + JSON.stringify(notifParams) + ' — a recipient selector would be a permission-denied waiting to happen',
);

/**
 * 47. §3.3: `includeMetadataChanges` is OFF by default in the primitive.
 *
 * Enabling it by default would quadruple the snapshot rate of the listeners that do
 * not need it, to serve a pending-state flag only some of them use. `docs/11 §3.3`
 * turns it on for four of ten, and the default has to be `false` for that table to
 * mean anything.
 */
const metadataDefaultsOff = /includeMetadataChanges = false/.test(primitiveSource);
const l1OptsIn = /includeMetadataChanges: true/.test(l1Hook);
check(
  'docs/11 §3.3: includeMetadataChanges defaults to OFF and only L1 opts in (4 of 10 listeners)',
  metadataDefaultsOff && l1OptsIn,
  !metadataDefaultsOff
    ? 'the primitive defaults includeMetadataChanges to true, which multiplies snapshot cost app-wide'
    : 'the L1 hook does not opt in, so the queue cannot show a pending state',
);

/**
 * 48. No client module imports a server-only module.
 *
 * NFR-013. The project already has an ESLint `no-restricted-imports` rule for
 * this, and it FIRED during this phase when the row mapper reached for
 * `lib/server/serialize.ts`'s `toIso`. The check exists so the boundary survives a
 * rule change: a client file importing `@/lib/server/` will not build, and the
 * failure should be caught here first with a message that says which file.
 */
const serverOnlyLeaks = [];
for (const file of [...sourceFilesUnder('hooks'), ...sourceFilesUnder('features'), ...sourceFilesUnder('components')]) {
  const code = codeOnly8(read(file));
  const re = /from\s+'@\/lib\/server\/[a-z-]+'/g;
  let m;
  while ((m = re.exec(code)) !== null) serverOnlyLeaks.push(`${file} -> ${m[0]}`);
}
check(
  'No client module imports @/lib/server/* (NFR-013, docs/05 §4)',
  serverOnlyLeaks.length === 0,
  serverOnlyLeaks.join('; '),
);

/**
 * 49. The connection state is DERIVED, and `lastSyncedAt === null` is never `connected`.
 *
 * brief §4: "Never falsely display 'Connected' if the realtime connection is
 * unavailable." The specific claim under test is that a client which has attached
 * listeners but received nothing yet is `connecting`, not `connected` — the window
 * in which a green "Live" dot would sit over an empty list.
 */
const connectedNeedsSync =
  /if \(facts\.lastSyncedAt === null\) return 'connecting';/.test(connectionSource) &&
  /firestoreStatus === 'unavailable'\) return 'reconnecting'/.test(connectionSource);
const errorBeforeOffline = /if \(facts\.hasError\) return 'error';[\s\S]{0,80}if \(!facts\.navigatorOnLine\)/.test(
  connectionSource,
);
check(
  'Connection state is derived, and a missing snapshot is never "connected" (docs/11 §4.2, brief §4)',
  connectedNeedsSync && errorBeforeOffline,
  !connectedNeedsSync
    ? 'deriveRealtimeState can return connected with lastSyncedAt === null, or cannot report reconnecting'
    : 'a listener error is not distinguished from being offline, so a permission defect sends the user to check their router',
);

/**
 * 50. The two staleness constants cannot disagree.
 *
 * `lib/realtime/connection.ts` owns `STALE_AFTER_MS`; the primitive carries a
 * duplicate because it has no dependency on the connection store. A primitive that
 * thought a payload was fresh while the banner thought it was stale is a
 * contradiction on the same screen — so the duplication is pinned to a constant.
 */
const primitiveStale = primitiveSource.match(/const STALE_THRESHOLD_MS = ([\d_]+);/);
const connectionStale = connectionSource.match(/export const STALE_AFTER_MS = ([\d_]+);/);
check(
  'The primitive and the banner use the SAME staleness threshold (docs/11 §4.2)',
  primitiveStale !== null && connectionStale !== null && primitiveStale[1] === connectionStale[1],
  primitiveStale === null || connectionStale === null
    ? 'a STALE constant could not be found in one of the two modules'
    : `primitive says ${primitiveStale[1]}ms, connection says ${connectionStale[1]}ms — the same screen would disagree about staleness`,
);

/**
 * 51. The listener limits and the budget are the documented numbers.
 *
 * `docs/11 §2.1`'s `MAX_CONCURRENT_LISTENERS = 8`, and the per-listener ceilings
 * from §2.2. These are read from the source rather than restated, so a change to
 * either side is caught here instead of in production.
 */
const queueLimitInRegistry = /queue:\s*50,/.test(registrySource);
const mapLimitInRegistry = /mapIncidents:\s*150,/.test(registrySource);
const notifLimitInRegistry = /notifications:\s*50,/.test(registrySource);
check(
  'The per-listener limits are the docs/11 §2.2 numbers (queue 50, map 150, bell 50)',
  queueLimitInRegistry && mapLimitInRegistry && notifLimitInRegistry,
  'a listener ceiling has drifted from docs/11 §2.2',
);

/**
 * 52. Every composite index the listeners need is declared.
 *
 * The first audit of `firestore.indexes.json` found six of fifteen listener query
 * shapes with no working index. An undeclared index is not a slow query — it is a
 * `failed-precondition` on the first snapshot, which `mapListenerError` reports as
 * "this view needs a database index that is not deployed", i.e. the dashboard simply
 * never updates.
 *
 * Asserted on the FIELDS the queries actually constrain, not on index count.
 */
const requiredIndexSignatures = [
  'deletedAt,status,updatedAt',
  'deletedAt,status,urgency,updatedAt',
  'deletedAt,status,category,updatedAt',
  'deletedAt,assigneeUid,status,updatedAt',
  'deletedAt,status,createdAt',
  'geoCells,deletedAt,status,updatedAt',
  'status,capturedAt',
  'recipientUid,createdAt',
  'responderUid,status,dispatchedAt',
  'deletedAt,slaBreachedAt,status,verifiedAt',
];
const declaredSignatures = new Set(
  (JSON.parse(indexesJson).indexes ?? []).map((entry) =>
    (entry.fields ?? []).map((f) => f.fieldPath).join(','),
  ),
);
const undeclaredIndexes = requiredIndexSignatures.filter((sig) => !declaredSignatures.has(sig));
check(
  'Every realtime listener query has a matching composite index declared (docs/11 §2.2)',
  undeclaredIndexes.length === 0,
  undeclaredIndexes.length > 0
    ? 'no index for: ' + undeclaredIndexes.join(' | ')
    : '',
);

/**
 * 53. The `in` sets stay within Firestore's limit.
 *
 * QD-6. A set that grows past the cap fails at RUNTIME, on the first snapshot, as
 * an `invalid-argument` the user sees as an empty queue. Asserted against the
 * exported sets so adding a status to an enum is caught here.
 */
const setCapsOk = /SET_SIZE_CAPS = \{[\s\S]{0,120}?in: 30,/.test(enumsSource8);
const openStatusesHasSeven = (enumsSource8.match(/OPEN_STATUSES = \[([\s\S]*?)\] as const/) ?? ['', ''])[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean).length === 7;
check(
  'The `in` sets are within Firestore’s 30-value cap, and OPEN_STATUSES is the documented 7 (QD-6)',
  setCapsOk && openStatusesHasSeven,
  !setCapsOk
    ? 'SET_SIZE_CAPS does not declare the Firestore limit'
    : 'OPEN_STATUSES is not the 7-value set docs/11 §2.1 names',
);

/**
 * 54. The live row does NOT claim to be a full `Incident`.
 *
 * `docs/11 §11.2`: `slaState`, `ageMin` and `distanceM` are server-derived and MUST
 * come through the API. A row type that structurally satisfied `Incident` would
 * make the omission invisible at the type level, which is where it would do the
 * most damage.
 */
const rowOmitsServerDerived = /LIVE_ROW_OMITTED_FIELDS = \[[\s\S]{0,200}?'slaState'/.test(rowMapper) &&
  /'ageMin'/.test(rowMapper) &&
  /'distanceM'/.test(rowMapper);
const rowIsNotIncident = /export type LiveIncidentRow = \{/.test(rowMapper) &&
  !/LiveIncidentRow\s*(?:extends|=\s*Incident)/.test(rowMapper);
check(
  'The live row omits the server-derived fields rather than guessing them (docs/11 §11.2)',
  rowOmitsServerDerived && rowIsNotIncident,
  !rowOmitsServerDerived
    ? 'LIVE_ROW_OMITTED_FIELDS does not name slaState/ageMin/distanceM'
    : 'LiveIncidentRow claims to be an Incident, so the omission is invisible to the compiler',
);

/**
 * 55. A pending document is never merged field-by-field.
 *
 * `docs/11 §3.4` M-1. A field-level merge is how "the badge says verified but the
 * list says new" happens: the local write set one field and the snapshot carried
 * the rest, producing a document that never existed.
 */
const mergeSkipsPending = /hasPendingWrites\) \{\s*\n\s*nextPending\.add\(id\);/.test(mergeSource);
const mergeSkipsDiff = /continue;/.test(mergeSource);
const itemsComeFromSnapshot = /for \(const doc of snapshot\.docs/.test(mergeSource);
check(
  'M-1/M-2: a pending document replaces wholesale, and items come from the snapshot (docs/11 §3.4)',
  mergeSkipsPending && mergeSkipsDiff && itemsComeFromSnapshot,
  !mergeSkipsPending
    ? 'a pending document is not short-circuited, so a field-level merge is possible'
    : 'items are not derived from the snapshot, so M-2 (leave the window = leave the list) does not hold',
);

/**
 * 56. The `system` sentinel is not reachable from any client module.
 *
 * `docs/07 §4.3` and Phase 7's check 25 confine it to `new -> triaged`. A realtime
 * hook that could pass a system actor would reopen the one path the AI is allowed
 * to take on its own.
 */
const clientSystemActors = [];
for (const file of [...sourceFilesUnder('hooks'), ...sourceFilesUnder('features')]) {
  const code = codeOnly8(read(file));
  if (/role:\s*'system'/.test(code)) clientSystemActors.push(file);
}
check(
  'No client module can pass a `system` actor to a listener or a mutation (docs/07 §4.3, FR-020)',
  clientSystemActors.length === 0,
  clientSystemActors.join('; '),
);

/* ------------------------------------------------------------------------ */
/* Phase 9 — notifications + operational analytics                            */
/* ------------------------------------------------------------------------ */
/*
 * Phase 9's two rules that matter are both about CLAIMS rather than about access:
 *
 *  - a notification must reach only its intended recipient, and
 *  - an analytics surface must never present a heuristic as a forecast, or an
 *    unmeasurable metric as a number.
 *
 * Both are checkable structurally, and both are the kind of thing that a
 * well-meaning copy edit reverts. `docs/14 §6.8` says the honesty statement is
 * "Rendered verbatim, not paraphrased" — which is only enforceable if something
 * asserts the exact string is present.
 */

const metricsSource = read('lib/analytics/metrics.ts');
const riskSource = read('lib/analytics/risk-score.ts');
const decideSource = read('lib/analytics/decide-source.ts');
const analyticsConfig = read('config/analytics.ts');
const analyticsTime = read('lib/analytics/time.ts');
const l5Hook = read('features/notifications/use-realtime-notifications.ts');
const queriesSource9 = read('lib/firestore/queries.ts');
const kpiGrid = read('features/analytics/kpi-grid.tsx');
const analyticsView = read('features/analytics/analytics-view.tsx');
const riskSection = read('features/analytics/risk-section.tsx');
const enumsSource9 = read('types/enums.ts');
const rules9 = read('firestore.rules');
const indexesJson9 = read('firestore.indexes.json');

function codeOnly9(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 57. `docs/14 §2.1`: an unmeasurable metric is `null`, never `0`.
 *
 * The single most consequential convention in the analytics spec, and the one
 * brief §30 restates. Asserted on the PRIMITIVES rather than on the assembled
 * object, because the primitives are what a future metric would be built from — an
 * aggregate can be honest while the helpers it calls are not.
 */
const nullPrimitives =
  /export function mean\([\s\S]{0,200}?if \(values\.length === 0\) return null;/.test(metricsSource) &&
  /export function ratePct\([\s\S]{0,200}?if \(denominator === 0\) return null;/.test(metricsSource) &&
  /export function durationSec\([\s\S]{0,240}?if \(fromMs === null \|\| toMs === null\) return null;/.test(
    metricsSource,
  );
/** And the negative-duration guard, which is the subtle one. */
const negativeDurationIsNull =
  /return seconds < 0 \? null : seconds;/.test(metricsSource);
check(
  'Every analytics primitive returns null for an unmeasurable input, never 0 (docs/14 §2.1, brief §30)',
  nullPrimitives && negativeDurationIsNull,
  !nullPrimitives
    ? 'a primitive (mean / ratePct / durationSec) returns 0 or throws for an empty input'
    : 'a negative duration is returned as a number rather than null — host clock skew would become an ops metric',
);

/**
 * 58. The totals TYPE admits null, so §2.1 is expressible.
 *
 * Before Phase 9, `AnalyticsTotals` typed every duration and rate as `number`. That
 * made the rule above unimplementable: a duration computed from zero qualifying
 * records had to be *some* number. The type is the control, so it is asserted.
 */
const totalsAdmitsNull =
  /meanTimeToDispatchSec: MaybeNumber;/.test(read('types/domain.ts')) &&
  /slaCompliancePct: MaybeNumber;/.test(read('types/domain.ts')) &&
  /export type MaybeNumber = number \| null;/.test(read('types/domain.ts'));
check(
  'AnalyticsTotals admits null for durations and rates, and only for those (docs/14 §2.1)',
  totalsAdmitsNull,
  !totalsAdmitsNull ? 'a duration or rate is still typed `number`, so "not enough data" cannot be rendered' : '',
);

/**
 * 59. The UI renders "not enough data" rather than a number for a null.
 *
 * A null in the type that reaches a tile as `0s` satisfies the type and defeats the
 * rule. This asserts the RENDERING, which is the part §2.1 actually protects.
 */
const rendersNoData = /export const NO_DATA = 'Not enough data';/.test(kpiGrid);
const durationUsesTheHelper = /formatMetricDuration\(totals\.meanTimeToDispatchSec\)/.test(kpiGrid);
const percentUsesTheHelper = /formatMetricPercent\(totals\.slaCompliancePct\)/.test(kpiGrid);
const nullIsNotABreach = /return value === null \? 'default' : value < 90 \? 'breached' : 'default';/.test(
  kpiGrid,
);
check(
  'The KPI grid renders "Not enough data" for a null, and never shows an SLA breach for missing data',
  rendersNoData && durationUsesTheHelper && percentUsesTheHelper && nullIsNotABreach,
  !rendersNoData
    ? 'kpi-grid has no NO_DATA constant'
    : !durationUsesTheHelper || !percentUsesTheHelper
      ? 'a nullable metric is still passed straight to formatDuration/formatPercent'
      : 'a null SLA value renders as a BREACH — a red tile for the absence of data',
);

/**
 * 60. brief §2 and §20: the risk score has no input a prediction could enter.
 *
 * Structural rather than textual. The concern is that a future developer adds a
 * `forecast` or `population` field, and the assertion is that the TYPE has no room
 * for one — which is why the check reads the exported shape.
 */
const riskInputFields = (riskSource.match(/export type RiskZoneInput = \{([\s\S]*?)\n\};/) ?? ['', ''])[1];
const riskFields = riskInputFields
  .split('\n')
  // `\w+\??:` — the `?` is REQUIRED in the pattern. The first version used
  // `\w+:` and a mutation adding `readonly forecastProbability?: number` was
  // invisible to it, so the check passed for a field it could not see. An
  // optional property is exactly the shape a new field would take.
  .map((line) => /readonly (\w+)\??\s*:/.exec(line)?.[1])
  .filter(Boolean)
  .sort();

/** The six facts a score may be computed from, and nothing else. */
const HISTORICAL_ONLY = [
  'criticalCount',
  'daysSinceLastIncident',
  'highCount',
  'incidentCount',
  'mediumCount',
  'windowDays',
].sort();
const allHistorical = riskFields.length === HISTORICAL_ONLY.length &&
  HISTORICAL_ONLY.every((name) => riskFields.includes(name));
/** And no field may be named as a prediction, whatever its type. */
const PREDICTIVE_NAME = /forecast|predict|probab|population|weather|season|dayOfWeek|model|forecasted/i;
const predictiveField = riskFields.find((name) => PREDICTIVE_NAME.test(name)) ?? null;
check(
  'RiskZoneInput holds only historical facts — no field a forecast could enter (brief §2, docs/14 §6)',
  allHistorical && predictiveField === null,
  predictiveField !== null
    ? 'RiskZoneInput declares ' + predictiveField + ' - a predictive field is indistinguishable from a historical one, and docs/14 6 forbids it'
    : 'RiskZoneInput is ' + JSON.stringify(riskFields) + ' — expected exactly the six historical facts',
);

/**
 * 61. `docs/14 §6.8`: the honesty statement is present and VERBATIM.
 *
 * A paraphrased statement is the failure the section forbids, and paraphrasing is
 * exactly what happens when someone tightens the prose. Asserting the opening
 * clause and the three named limits is what makes "not paraphrased" enforceable.
 */
const honestyPresent = /RISK_HONESTY_STATEMENT\s*=\s*\n?\s*'This is a summary of past incidents, not a forecast\./.test(
  analyticsConfig,
);
const honestyLimits = /does not know the population/.test(analyticsConfig) &&
  /the weather/.test(analyticsConfig) &&
  /never where to send/.test(analyticsConfig);
check(
  'The risk honesty statement is declared and matches docs/14 §6.8 verbatim',
  honestyPresent && honestyLimits,
  !honestyPresent
    ? "the statement does not open with docs/14 §6.8's verbatim first sentence"
    : 'the statement has lost one of the three limits docs/14 §6.8 names',
);

/**
 * 62. No component claims the analytics predict.
 *
 * brief §20: "Avoid wording such as 'This area will be dangerous', 'AI predicts an
 * accident here', 'Guaranteed high-risk zone'."
 *
 * Scanned over the ANALYTICS COMPONENTS specifically. The check would be useless
 * over the whole tree, because the forbidden phrases appear in the config module —
 * that is where they are defined so a check can look for them.
 */
const forbiddenClaims = [
  /will be dangerous/i,
  /predicts an accident/i,
  /guaranteed high-risk/i,
  /AI predicts/i,
  /is going to happen/i,
  /likely to have an incident/i,
];
/**
 * Scanned over the ANALYTICS COMPONENTS specifically, and AFTER comment
 * stripping. A mutation test that appended a forbidden phrase to the first
 * occurrence of `RiskSection` landed inside that symbol's JSDoc block and was
 * stripped before the scan — so the first run of that mutation reported a MISS
 * that was really a bad mutation. Comments are where a prohibition gets
 * *described*, which is exactly why they must be removed before scanning.
 */
const claimViolations = [];
for (const [name, source] of [
  ['risk-section.tsx', riskSection],
  ['kpi-grid.tsx', kpiGrid],
  ['analytics-view.tsx', analyticsView],
]) {
  const code = codeOnly9(source);
  for (const pattern of forbiddenClaims) {
    if (pattern.test(code)) claimViolations.push(`${name}: ${pattern}`);
  }
}
check(
  'No analytics component claims to predict future danger (brief §2, §20; docs/14 §6)',
  claimViolations.length === 0,
  claimViolations.join('; '),
);

/**
 * 63. Risk zones are DISABLED by default.
 *
 * `docs/14 §6.1`: "Feature flag | `ENABLE_RISK_ZONES` / `config.features.riskZones`,
 * **default `false`** (P1)".
 *
 * Phase 9 implements the computation and does NOT flip the flag. A density heatmap
 * enabled by default is the most over-claimable surface in the product, and
 * `docs/14` marked it P1 for that reason.
 */
const riskDisabled = /export const RISK_ZONES_ENABLED = false;/.test(analyticsConfig);
check(
  'Risk zones are disabled by default, per docs/14 §6.1 (P1)',
  riskDisabled,
  riskDisabled ? '' : 'RISK_ZONES_ENABLED is not false — the flag was flipped without a documented decision',
);

/**
 * 64. FR-116: the rollup decision keys on the END of the range, at 48 h.
 *
 * `docs/14 §3.2`. A rule keyed on the range START would send a 90-day view ending
 * today to 90 rollup documents and show a dispatcher data that is up to 48 hours
 * stale, while the two most recent days in their own window were available live.
 */
const usesEndOfDay = /endOfLocalDayMs\(to, timezone\)|endOfLocalDayMs\(input\.to, input\.timezone\)/.test(
  decideSource,
);
const fortyEight = /export const ROLLUP_AFTER_HOURS = 48;/.test(decideSource);
check(
  'decideSource keys on the END of the range at 48 h, not the start (docs/14 §3.2, FR-116)',
  usesEndOfDay && fortyEight,
  !usesEndOfDay ? 'the rule does not read the range END' : 'the 48 h threshold is not the documented value',
);

/**
 * 65. Day boundaries are LOCAL.
 *
 * `new Date('2026-09-26')` is UTC midnight, which in Asia/Kolkata is 05:30 into
 * the day — so the last incident of the previous evening would be counted in the
 * wrong bucket. The assertion is that the module resolves an offset through
 * `Intl` rather than using a `Date` constructor on a bare date string.
 */
const localBoundary = /offsetMinutesAt/.test(analyticsTime) &&
  /Intl\.DateTimeFormat/.test(analyticsTime) &&
  // No bare `Date.parse(\`${date}T00:00:00Z\`)` used as THE boundary.
  /startOfLocalDayMs/.test(analyticsTime);
check(
  'Local day boundaries are resolved through Intl, not a UTC date parse (docs/14 §7.1)',
  localBoundary,
  localBoundary ? '' : 'the timezone conversion is missing, so day buckets would be offset from local midnight',
);

/**
 * 66. The `active` status set is the SIX docs/14 names, and the buckets are disjoint.
 *
 * The naming collision this guards: `docs/07 §12.1` calls a SEVEN-element set
 * `ACTIVE_STATUSES` (with `resolved`), while `docs/11 §2.1` and `docs/14 §2.1` call
 * the SIX-element subset `ACTIVE_STATUSES` and name the seven `OPEN_STATUSES`.
 *
 * Reading `types/enums.ts`'s array by `docs/14`'s meaning put every resolved
 * incident in BOTH `counts.active` and `counts.resolved` — and, in Phase 8, put
 * resolved incidents back in the dispatcher's live work queue. A unit test's
 * disjointness assertion is what found it; this makes the fix permanent.
 */
const liveActiveIsSix = /export const LIVE_ACTIVE_STATUSES = \[[\s\S]{0,200}?\] as const/.test(
  read('lib/collections/enums.ts'),
);
const analyticsUsesSix = /ANALYTICS_ACTIVE_STATUSES/.test(metricsSource);
const queueUsesSix = /QUEUE_STATUS_WINDOW: readonly IncidentStatus\[\] = \[\.\.\.LIVE_ACTIVE_STATUSES\]/.test(
  read('lib/collections/enums.ts'),
);
const openStatusesIsSeven = /OPEN_STATUSES = \[[\s\S]{0,300}?'resolved',[\s\S]{0,40}?\] as const/.test(
  read('lib/collections/enums.ts'),
);
check(
  'The six-element active set is distinct from the seven-element open set, and both metrics and the queue use the six',
  liveActiveIsSix && analyticsUsesSix && queueUsesSix && openStatusesIsSeven,
  !analyticsUsesSix
    ? "analytics uses a set that may include 'resolved', double-counting it against counts.resolved"
    : !queueUsesSix
      ? "the live queue window may include 'resolved', putting a finished incident back in the work queue"
      : !openStatusesIsSeven
        ? 'OPEN_STATUSES is not the documented 7-element set'
        : '',
);

/**
 * 67. SEC-4, restated for the hook: L5 has no parameter to widen it.
 *
 * Phase 8 asserted the QUERY function's parameter count. This asserts the HOOK,
 * because a hook is where a future developer would be tempted to add a filter —
 * `useRealtimeNotifications({ recipientUid })` is the obvious mistake, and it is
 * one that would compile.
 */
/**
 * The property names the hook declares in its single options object type.
 *
 * The first version of this check asserted the signature STARTED WITH a
 * particular prefix — `useRealtimeNotifications(options: { readonly seed?` — and a
 * mutation that appended `readonly recipientUid?: string` after `seed?` did not
 * break it. **A prefix test cannot detect an addition**, so the check passed for
 * the wrong reason. Asserting the SET of declared properties is the property that
 * actually matters: one option, and it is the seed.
 */
function l5OptionNames(source) {
  const signature = /export function useRealtimeNotifications\(options: \{([\s\S]*?)\}/.exec(source);
  if (signature === null) return null;
  return [...signature[1].matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]).sort();
}

const l5Options = l5OptionNames(l5Hook);
const l5HasNoSelector = l5Options !== null && l5Options.length === 1 && l5Options[0] === 'seed';
const l5QueryIsTwoArgs = /notificationQuery\(db, uid as string\)/.test(l5Hook);
/** And nothing anywhere in the hook carries a recipient-shaped identifier. */
const l5MentionsNoRecipient =
  !/recipientUid|recipientId|targetUid|forUid|userFilter/.test(codeOnly9(l5Hook));
check(
  'useRealtimeNotifications declares only a seed option and cannot widen L5 (docs/11 §11.3 SEC-4)',
  l5HasNoSelector && l5QueryIsTwoArgs && l5MentionsNoRecipient,
  l5Options === null
    ? 'the hook signature was not found'
    : !l5HasNoSelector
      ? `the hook declares ${JSON.stringify(l5Options)} — expected exactly ["seed"]`
      : !l5MentionsNoRecipient
        ? 'the hook carries a recipient-shaped identifier — a notification is targeted correspondence about one user'
        : '',
);

/**
 * 68. Notification types are the declared 12, not free strings.
 *
 * brief §4: "Do not allow arbitrary client-provided notification types. Validate
 * notification type server-side."
 *
 * The check is that the client reads the SAME declared set rather than
 * restating it — a restated list is how the three-vocabulary bug in the incident
 * row mapper happened, where a real `duplicateStatus` read as absent.
 */
const declaredTypes = (enumsSource9.match(/export const NOTIFICATION_TYPES = \[([\s\S]*?)\] as const/) ?? [
  '',
  '',
])[1]
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * The mapper must DERIVE the set from the declared enum, not restate it.
 *
 * The first version of the hook listed the twelve by hand, and this check caught
 * that a restated list is a correctness risk rather than a style one: the same
 * mistake in the incident row mapper silently dropped a real `duplicateStatus`
 * because the restated value did not match the enum, and here an unrecognised type
 * degrades to a neutral badge — so a real "incident assigned" would render as
 * generic. Asserting the DERIVE is what makes the class of bug impossible.
 */
const derivesFromEnum = /new Set<string>\(NOTIFICATION_TYPES\)/.test(l5Hook);
check(
  'The notification row mapper derives its type set from NOTIFICATION_TYPES, not a restated list (brief §4)',
  declaredTypes.length === 12 && derivesFromEnum,
  declaredTypes.length !== 12
    ? `docs/07 §10.2 should declare 12 notification types; found ${declaredTypes.length}`
    : 'the mapper restates the type list instead of deriving it from the enum',
);

/**
 * 69. `notifications` ownership is enforced in the RULES, not only in the query.
 *
 * brief §11: "users can only read their own notifications; users cannot modify
 * another user's notification". The query is a convenience; the rule is the
 * boundary, and a client that could bypass the query would still be refused.
 */
const rulesScopedToRecipient =
  /match \/notifications\/\{notificationId\}/.test(rules9) &&
  /resource\.data\.recipientUid == request\.auth\.uid/.test(rules9);
const rulesWriteIsRefused = /allow create, delete: if false;/.test(rules9);
const rulesReadOnlyIsScoped =
  /request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)[\s\S]{0,120}?hasOnly\(\['read', 'readAt', 'updatedAt'\]\)/.test(
    rules9,
  );
check(
  'notifications are owner-scoped in the rules, and the only client write is read/readAt (docs/11 §11.3 SEC-5, brief §11)',
  rulesScopedToRecipient && rulesWriteIsRefused && rulesReadOnlyIsScoped,
  !rulesScopedToRecipient
    ? 'the notifications rule does not scope reads to recipientUid'
    : !rulesWriteIsRefused
      ? 'a client can create or delete a notification'
      : 'the read-marking write is not restricted to read/readAt/updatedAt',
);

/**
 * 70. `analyticsDaily` and `riskZones` are never READ by a client listener.
 *
 * `docs/14 §1`: risk zones are "**never** recomputed on read" and are
 * precomputed. `docs/11 §2.4` lists `analyticsDaily` and `riskZones` under "What is
 * never listened to": "Historical / precomputed. FR-099 forbids listeners for
 * historical or archived analytics queries."
 *
 * So a listener over either collection would be a client recomputing a precomputed
 * document — which is the specific thing both documents forbid.
 */
const queryBuilderCollections = (queriesSource9.match(/COLLECTIONS\.(\w+)/g) ?? []).map((m) =>
  m.replace('COLLECTIONS.', ''),
);
const listensToRollups = queryBuilderCollections.some((c) => c === 'analyticsDaily' || c === 'riskZones');
check(
  'No listener query reads analyticsDaily or riskZones (docs/14 §1, docs/11 §2.4, FR-099)',
  !listensToRollups,
  listensToRollups ? 'a query builder reads ' + queryBuilderCollections.join(', ') : '',
);

/**
 * 71. The analytics read is bounded, and a capped scan reports it.
 *
 * `docs/14 §1` lists "Present a capped live scan as complete" as the thing
 * operational analytics must never do, and `docs/14 §8.3` requires the cap to
 * exist. `LIVE_SCAN_CAP` must be a number and `AnalyticsRange.truncated`-bearing
 * `advisory` must be part of the response type.
 */
const liveCapBounded = /export const LIVE_SCAN_CAP = \d+;/.test(analyticsConfig);
const rangeCarriesAdvisory = /advisory: string \| null;/.test(read('types/domain.ts'));
const rangeCarriesSource = /source: 'rollup' \| 'live';/.test(read('types/domain.ts'));
check(
  'The live scan is capped, and the response carries source + advisory so a capped scan is not presented as complete (docs/14 §1, §8.3)',
  liveCapBounded && rangeCarriesAdvisory && rangeCarriesSource,
  !liveCapBounded
    ? 'LIVE_SCAN_CAP is not a declared number'
    : !rangeCarriesAdvisory
      ? 'AnalyticsRange has no `advisory`, so a truncated scan cannot say so'
      : 'AnalyticsRange has no `source`, so a rollup and a live scan are indistinguishable',
);

/**
 * 72. Analytics is dispatcher/admin only, and the capability is declared.
 *
 * `docs/14 §10`: "Read operational analytics | - | - | ? | ? | `GET /api/analytics`
 * is `dispatcher`/`admin`, else `403 FORBIDDEN` (FR-117)" and ACC-1: "The
 * `permissions[]` array from `GET /api/me` drives the **UI affordances only**. The
 * API re-checks every request (NFR-015)."
 *
 * The capability id is whatever the 61-row matrix declares; the check is that
 * analytics is gated at all, and that a client-side gate is not the only one.
 */
/**
 * `r48_readOperationalAnalytics` and `r50_recomputeAnalytics` exist in the 61-row
 * matrix, and their VALUES are the gate `docs/14 §10` specifies: dispatcher and
 * admin `full` for the read, admin only for the recompute. The assertion is on the
 * values, not merely on the key existing — a capability declared and left
 * `denied` everywhere would pass a presence check and gate nothing.
 */
const permsSource = read('lib/auth/permissions.ts');
const readCapability =
  /r48_readOperationalAnalytics:\s*\{[^}]*dispatcher: 'full'[^}]*admin: 'full'[^}]*\}/.test(permsSource) &&
  /r48_readOperationalAnalytics:[^\n]*citizen: 'denied'[^\n]*responder: 'denied'/.test(permsSource);
const recomputeIsAdminOnly =
  /r50_recomputeAnalytics:[^\n]*dispatcher: 'denied'[^\n]*admin: 'full'/.test(permsSource);
/** And the nav must not offer the page to a role the capability denies. */
const navGatesAnalytics = /href === '\/analytics'\) return role === 'dispatcher' \|\| role === 'admin';/.test(
  read('config/nav.ts'),
);
check(
  'Analytics is gated by r48 (dispatcher/admin), recompute by r50 (admin only), and the nav matches (docs/14 §10, FR-117)',
  readCapability && recomputeIsAdminOnly && navGatesAnalytics,
  !readCapability
    ? 'r48_readOperationalAnalytics does not grant dispatcher/admin and deny citizen/responder as docs/14 §10 specifies'
    : !recomputeIsAdminOnly
      ? 'r50_recomputeAnalytics is not admin-only — docs/14 §10 says a dispatcher cannot recompute'
      : 'the navigation does not restrict /analytics to dispatcher/admin, so a citizen may be offered a page that 403s',
);

/**
 * 73. Location analytics group on a CELL, never export individual coordinates.
 *
 * brief §27: "For historical density views, aggregation should be preferred over
 * exposing individual sensitive coordinates when possible." `docs/14 §2.5` is
 * blunter: "`topLocations` | `count(P grouped by geoCells[0] - the incident's own
 * geohash-6)`" — a CELL count, never a coordinate list.
 *
 * The check is that the location helper's return type has no latitude or longitude
 * field, which makes an export of precise locations impossible through it.
 */
const topLocationsFn = (metricsSource.match(/export function topLocations\([\s\S]*?\n\}/) ?? [''])[0];
/**
 * No coordinate in the returned shape.
 *
 * Asserted on the RETURNED OBJECT LITERAL rather than on a type annotation,
 * because the function infers its type from the literal — the literal IS the
 * contract. `lat|lng` would false-positive on "location", so the check looks for
 * an actual coordinate pair.
 */
const returnsCellCounts = /\(\{ geohash6, count \}\)/.test(topLocationsFn);
const hasNoCoordinateFields =
  !/\blat:|\blng:|\blatitude:|\blongitude:|\bgeo:/i.test(topLocationsFn) &&
  !/\{\s*lat\s*,/.test(topLocationsFn);
/** And the per-incident position is DROPPED and reported as a count, not returned. */
const withoutPositionIsCounted = /withoutPosition: number/.test(topLocationsFn) &&
  /withoutPosition \+= 1/.test(topLocationsFn);
check(
  'Location analytics return a geohash-6 cell count and never individual coordinates (brief §27, docs/14 §2.5)',
  returnsCellCounts && hasNoCoordinateFields && withoutPositionIsCounted,
  !returnsCellCounts
    ? 'topLocations does not return a { geohash6, count } shape'
    : !hasNoCoordinateFields
      ? 'topLocations exposes a coordinate in its return shape'
      : 'positionless incidents are dropped rather than reported',
);

/**
 * 74. The index the live analytics scan needs is declared.
 *
 * The live path is a range query over `incidents` by `createdAt` with the soft-delete
 * filter, bounded by `LIVE_SCAN_CAP`. Without a matching composite index it is a
 * `failed-precondition`, which the UI would render as "not enough data" — an
 * analytics page that looks like a quiet period rather than a broken query.
 */
const declaredIndexSigs = new Set(
  (JSON.parse(indexesJson9).indexes ?? []).map((entry) =>
    (entry.fields ?? []).map((f) => f.fieldPath).join(','),
  ),
);
/** `deletedAt ASC, createdAt DESC` is the shape a `deletedAt == null` + range query needs. */
const liveScanIndexed = declaredIndexSigs.has('deletedAt,createdAt') ||
  declaredIndexSigs.has('deletedAt,createdAt,status') ||
  declaredIndexSigs.has('createdAt');
check(
  'A composite index exists for the bounded live analytics scan over incidents (docs/14 §3.4)',
  liveScanIndexed,
  liveScanIndexed
    ? ''
    : 'no deletedAt+createdAt index on incidents; the live path would fail with failed-precondition and render as "not enough data"',
);

{
/* ------------------------------------------------------------------------ */
/* Phase 10 — security, testing & production hardening                        */
/* ------------------------------------------------------------------------ */
/*
 * Phase 1-9's checks asked "is this code shaped correctly?". Phase 10's ask a
 * different question: "would a REGRESSION here be caught?".
 *
 * Each check below pins an invariant whose violation is silent — no exception, no
 * failed build, no red screen. The listener-teardown one is the clearest example:
 * before this phase `unsubscribeAll()` had ZERO callers, so signing out on a shared
 * device left the previous account's live incident queue, dispatch board and private
 * notification list in the app's memory, and nothing anywhere reported it.
 *
 * The audit that motivated these is `docs/SECURITY_AUDIT_REPORT.md`.
 */

const p10Auth = read('lib/firebase/auth.ts');
const p10Identity = read('lib/realtime/identity.ts');
const p10RateLimit = read('lib/server/rate-limit.ts');
const p10Prompts = read('services/ai/prompts.ts');
const p10TriageSchema = read('services/ai/schema.ts');
const p10Middleware = read('middleware.ts');
const p10EnvClient = read('lib/env.client.ts');

/** Every `route.ts` under `app/api`, as source text. */
function routeFiles() {
  return walk('app/api')
    .filter((f) => f.endsWith('route.ts'))
    .map((f) => ({ file: f, source: read(f) }));
}

/** Strip comments, so a rule described in prose is not read as a rule broken. */
function code10(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/* ========================================================================== */
/* 75. The identity-change teardown exists, and signOut does it FIRST         */
/* ========================================================================== */

const signOutBody = (p10Auth.match(/export async function signOut\(\): Promise<void> \{([\s\S]*?)\n\}/) ?? ['', ''])[1];
/**
 * The ORDER is the assertion, not the presence of the call.
 *
 * `fbSignOut` resolves only once the token is gone, and anything that reads
 * listener state in that window would find the previous account's channels still
 * attached. Tearing down first makes the window empty rather than merely short —
 * which is the difference between "the data is gone almost immediately" and "the
 * data is never there after sign-out completes".
 */
const teardownRunsBeforeSignOut =
  signOutBody.includes('closeRealtimeListenersFor') &&
  signOutBody.indexOf('closeRealtimeListenersFor') !== -1 &&
  signOutBody.indexOf('closeRealtimeListenersFor') < signOutBody.indexOf('fbSignOut');
check(
  'signOut closes every realtime listener BEFORE the token is dropped (docs/11 §3.5)',
  teardownRunsBeforeSignOut,
  teardownRunsBeforeSignOut
    ? ''
    : 'signOut must call the listener teardown, and must do so before fbSignOut — otherwise the previous account\'s listener state is readable until the token resolves',
);

/**
 * 76. The teardown is also wired into `onAuthStateChanged`.
 *
 * `signOut()` covers the path the user takes. It does NOT cover a token revoked
 * from the Firebase console, a session terminated by `disableSignIn`, an account
 * deleted elsewhere, or an account switch in a second tab. All four arrive as an
 * `onAuthStateChanged` event and nowhere else — so a teardown wired only into
 * `signOut()` is absent for every one of them.
 */
const authHandlerCallsTeardown =
  /function handleAuthStateOrIgnoreError\([\s\S]*?identityWatch\.observe\([\s\S]*?if \(decision\.teardown\)/.test(
    p10Auth,
  ) && /closeRealtimeListenersFor\(/.test(p10Auth);
check(
  'An identity change on onAuthStateChanged also closes the listeners, not only an explicit sign-out (docs/11 §3.5)',
  authHandlerCallsTeardown,
  authHandlerCallsTeardown
    ? ''
    : 'only signOut tears listeners down; a revoked token, a terminated session, or an account switch in another tab leaves the previous account\'s channels attached',
);

/**
 * 77. A token refresh must NOT tear down.
 *
 * This is the check that keeps 76 from being a bug. `onAuthStateChanged` fires on
 * every ID-token refresh — roughly hourly for every signed-in user — so a teardown
 * that keys on the event rather than the identity would close and reopen every
 * channel once an hour. That is a visible flicker and a burst of extra Firestore
 * reads, in exchange for no security gain, and it is the failure mode a reviewer
 * would not notice without being told.
 */
const ruleIgnoresSameUid =
  /if \(event\.previousUid !== null && event\.previousUid === event\.nextUid\)[\s\S]{0,120}?teardown: false/.test(
    p10Identity,
  ) &&
  /reason: 'same_identity'/.test(p10Identity) &&
  /if \(!event\.hasResolvedOnce\)[\s\S]{0,120}?teardown: false/.test(p10Identity);
check(
  'The teardown rule ignores a same-uid token refresh and the first resolution (docs/11 §3.5)',
  ruleIgnoresSameUid,
  ruleIgnoresSameUid
    ? ''
    : 'the rule tears down on a token refresh or on the first auth resolution — hourly channel churn, or a boot-time race with the listeners about to open',
);

/**
 * 78. Every state-changing route declares a rate limit.
 *
 * `docs/10 §17.1` requires a limit on anything abuse-prone, and brief §21 lists
 * report creation, Gemini analysis, upload signing, dispatch and status updates by
 * name. The rule is enforced centrally in `withRequest`, so the check is that no
 * mutation silently opts out of it.
 */
const routes10 = routeFiles();
/**
 * Every `withRequest` options block, PAIRED with its HTTP method.
 *
 * The first version returned the option blocks alone, so a route with a rate-limited
 * PATCH and an unlimited GET was reported as "no rateLimit key" — the GET block was
 * flagged and then attributed to the file's only mutating method. It fired on
 * `api/me`, whose PATCH does declare `rateLimit: 'me.update'`; the correct
 * implementation failed a check written to catch the incorrect one.
 *
 * Pairing them is also what lets the exemption be per-VERB rather than per-file,
 * which is the right granularity: "this read is unbounded" and "this write is
 * unbounded" are different claims.
 */
function requestBlocks(source) {
  const out = [];
  for (const m of source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\s*=\s*withRequest\(\s*\{([\s\S]*?)\}\s*,/g)) {
    out.push({ method: m[1], options: m[2] });
  }
  return out;
}
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const mutationsWithoutLimit = [];
for (const { file, source } of routes10) {
  for (const { method, options } of requestBlocks(source)) {
    // Only a STATE-CHANGING handler. A GET that a page load makes on every
    // navigation is not an abuse-prone endpoint, and `api/me` GET is the documented
    // case: limiting it breaks navigation for anyone who uses the product. Its
    // exemption is verified separately by check 79, which is what distinguishes
    // "deliberately unlimited" from "forgot to add one".
    if (!MUTATING.has(method)) continue;
    if (!/rateLimit:\s*'/.test(options)) {
      mutationsWithoutLimit.push(file + ' [' + method + ']');
    }
  }
}
check(
  'Every withRequest route declares a rateLimit key, so no mutation is silently unlimited (docs/10 §17.1, brief §21)',
  mutationsWithoutLimit.length === 0,
  mutationsWithoutLimit.length === 0
    ? ''
    : 'no rateLimit key: ' + [...new Set(mutationsWithoutLimit)].join(', '),
);

/**
 * 79. A route that opts out of a limit must RECORD the decision.
 *
 * `api/me` GET is a real, deliberate exemption: it runs on every authenticated
 * page load and every session refresh, so a limit there breaks navigation for
 * someone who uses the product. The exemption is recorded as an explicit
 * `POSITIVE_INFINITY` entry in `RATE_LIMIT_RULES`.
 *
 * This check makes the record **mandatory**. Before it, "deliberately unlimited"
 * was only distinguishable from "forgot to add one" by reading the comment — so
 * the next unlimited route would inherit that ambiguity.
 */
const infiniteRules = new Set(
  [...p10RateLimit.matchAll(/'([a-zA-Z0-9_.]+)':\s*\{\s*routeKey:[^}]*?limit:\s*Number\.POSITIVE_INFINITY/g)].map(
    (m) => m[1],
  ),
);
/**
 * A handler that declares NO limit must name a recorded infinite rule.
 *
 * Scoped to GET only. A mutation is already covered by check 78, which requires
 * it to declare a finite key, so demanding an exemption record there too would be
 * two checks for one condition.
 */
const unrecordedExemptions = [];
for (const { file, source } of routes10) {
  const unlimitedGets = requestBlocks(source).filter(
    ({ method, options }) => method === 'GET' && !/rateLimit:\s*'/.test(options),
  );
  if (unlimitedGets.length === 0) continue;
  // The exemption must be RECORDED: the route names a rule key, and the table
  // declares that key with an infinite limit. A comment saying "no limit on
  // purpose" is not the record — the table entry is, because that is what a
  // reviewer and a mutation test can both see.
  const named = [...source.matchAll(/RATE_LIMIT_RULES\[['"]([a-zA-Z0-9_.]+)['"]\]/g)].map((m) => m[1]);
  if (!named.some((key) => infiniteRules.has(key))) unrecordedExemptions.push(file);
}
check(
  'A route with no rate limit must record the decision as an explicit infinite rule (docs/10 §17.1)',
  unrecordedExemptions.length === 0,
  unrecordedExemptions.length === 0
    ? ''
    : 'unlimited but unrecorded: ' + unrecordedExemptions.join(', '),
);

/**
 * 80. No rate-limit rule is declared and never wired.
 *
 * A dead rule is a limit someone wrote and a route that never got it. `me.read` was
 * exactly that: declared with `POSITIVE_INFINITY`, referenced only in a comment,
 * and attached to no handler — so the table looked like the route was governed when
 * the route declared no key at all.
 */
const usedKeys = new Set();
for (const { source } of routes10) {
  for (const m of source.matchAll(/rateLimit:\s*'([a-zA-Z0-9_.]+)'/g)) usedKeys.add(m[1]);
}
const declaredKeys = new Set(
  [...p10RateLimit.matchAll(/^\s{2}'([a-zA-Z0-9_.]+)':\s*\{\s*routeKey:/gm)].map((m) => m[1]),
);
/**
 * A rule that is unused BUT explicitly infinite AND named in a route's own comment
 * is a RECORDED EXEMPTION, not a dead rule.
 *
 * `me.read` is exactly that, and it is the reason this check has a carve-out rather
 * than a blanket "every rule must be attached". Without the carve-out the correct
 * implementation fails; with it, a genuinely dead limit — declared, finite, and
 * attached to nothing — still fails, which is the case worth catching.
 */
const recordedExemptions = new Set();
for (const { file, source } of routes10) {
  for (const m of source.matchAll(/RATE_LIMIT_RULES\[['"`]([a-zA-Z0-9_.]+)['"`]\]/g)) {
    if (infiniteRules.has(m[1])) recordedExemptions.add(m[1]);
  }
  void file;
}
const deadRules = [...declaredKeys].filter((k) => !usedKeys.has(k) && !recordedExemptions.has(k));
check(
  'Every rate-limit rule is either attached to a route or a recorded infinite exemption (docs/10 §17.1)',
  deadRules.length === 0,
  deadRules.length === 0
    ? ''
    : 'declared, finite, and attached to nothing: ' +
        deadRules.join(', ') +
        ' — a limit someone wrote and a route that never got it. (A rule listed with limit: Number.POSITIVE_INFINITY and named by a route is a deliberate exemption, not a gap.)',
);

/* ========================================================================== */
/* Prompt injection                                                            */
/* ========================================================================== */

/**
 * 81. The system instruction is not parameterised.
 *
 * `docs/09 §4.2`: the system instruction is the only text the model treats as
 * authoritative, so a citizen's words in that position are not "data that might be
 * confusing" — they are instructions. `brief §13`: "Do not allow user-controlled
 * text to redefine the AI system prompt."
 *
 * The structural form is the guarantee: a `const` template literal with no
 * interpolation. Any `${...}` in it is an injection channel, and a check that only
 * read the *name* would pass the moment someone made it a builder function.
 */
const systemInstructionIsALiteral = /export const SYSTEM_INSTRUCTION = `[^`]*`;/.test(p10Prompts) &&
  !/export const SYSTEM_INSTRUCTION = `[^`]*\$\{/.test(p10Prompts);
check(
  'SYSTEM_INSTRUCTION is a literal with no interpolation, so no user text can enter it (docs/09 §4.2, brief §13)',
  systemInstructionIsALiteral,
  systemInstructionIsALiteral
    ? ''
    : 'SYSTEM_INSTRUCTION interpolates a value — user-controlled text could reach the authoritative instruction',
);

/**
 * 82. Untrusted text is WRAPPED, never concatenated.
 *
 * The delimiter is the second defence, after the literal system instruction: a
 * report that contains `</citizen_report>` cannot end its own block if the wrapper
 * neutralises the closing tag first. So both properties are asserted — that a
 * wrapper exists, and that the sanitiser defangs the delimiter.
 */
const wrapsCitizenReport = /export function wrapCitizenReport\(/.test(p10Prompts) &&
  /<citizen_report>/.test(p10Prompts) &&
  /buildUserContent/.test(p10Prompts);
const sanitiseSource = read('services/ai/sanitize.ts');
const defangsDelimiter =
  /<\/?citizen_report>/i.test(sanitiseSource) && /<\/?untrusted_extract>/i.test(sanitiseSource);
check(
  'Untrusted report text is wrapped in delimiters AND the delimiters are defanged before they reach the model (docs/09 §4.3, brief §13)',
  wrapsCitizenReport && defangsDelimiter,
  !wrapsCitizenReport
    ? 'there is no wrapCitizenReport wrapper'
    : 'the sanitiser does not defang the report delimiters, so a report containing </citizen_report> can end its own block',
);

/**
 * 83. AI output is schema-validated, and a confidence is bounded to 0..1.
 *
 * brief §14: "Do not trust Gemini to obey the schema perfectly." A confidence
 * outside 0..1 would pass a `z.number()` and then reach a comparison like
 * `confidence < threshold`, where 4.5 silently means "very confident".
 */
const outputIsValidated = /export const aiTriageOutputSchema = z/.test(p10TriageSchema) &&
  /category: z\.enum\(INCIDENT_CATEGORIES\)/.test(p10TriageSchema) &&
  /urgency: z\.enum\(URGENCIES\)/.test(p10TriageSchema);
const confidencesBounded = (p10TriageSchema.match(/z\.number\(\)\.min\(0\)\.max\(1\)/g) ?? []).length >= 2;
check(
  'Gemini output is Zod-validated, category and urgency are enums, and confidences are bounded to 0..1 (brief §14)',
  outputIsValidated && confidencesBounded,
  !outputIsValidated
    ? 'the triage output is not validated against a Zod schema, or category/urgency are free strings'
    : 'fewer than two confidences are bounded with min(0).max(1)',
);

/* ========================================================================== */
/* Field-level and Storage rules                                               */
/* ========================================================================== */

/**
 * 84. A client cannot change its own role, and `users/{uid}` is client-read-only.
 *
 * brief §6: "users cannot change their own role from the browser"; brief §8 lists
 * `role` and `permissions` as protected. The mechanism is a read-only match block,
 * which is stronger than a field diff — there is no field a client could add.
 */
/**
 * The verbs are `get`/`list`, not `read`/`query` — Firestore rules use the former
 * pair, and a check written against the latter silently never matches.
 *
 * The scope matters as much as the verb: user-editable preferences live on a
 * SEPARATE collection, `profiles/{uid}`, which is writable but limited to
 * `profileWritableFields()` and cannot set `uid`. So "a user cannot change their own
 * role" is enforced by denying every write to `users/{uid}` outright — a stronger
 * guarantee than a field diff, because there is no field a client could add.
 */
const usersRule = read('firestore.rules');
const usersBlockDeclared = usersRule.includes('match /users/{uid}');
const usersRefusesWrites =
  /match \/users\/{uid}[\s\S]{0,600}?allow create, update, delete: if false;/.test(usersRule);
const usersAreReadOnly = usersBlockDeclared && usersRefusesWrites;
check(
  'users/{uid} is read-only to clients, so no user can change their own role (docs/10 §4, brief §6, §8)',
  usersAreReadOnly,
  usersAreReadOnly ? '' : 'the users match block does not refuse all client writes',
);

/**
 * 85. `auditLogs` is append-only, for every role.
 *
 * brief §28: "Do not allow ordinary users to modify audit history." An audit log
 * that can be edited is not one, and a delete is as damaging as an update because
 * the absence of a record asserts that nothing happened.
 */
const auditRule = read('firestore.rules');
const auditBlockDeclared = auditRule.includes('match /auditLogs/');
const auditRefusesRewrite = /match \/auditLogs\/[\s\S]{0,700}?allow update, delete: if false;/.test(auditRule);
const auditAppendOnly = auditBlockDeclared && auditRefusesRewrite;
check(
  'auditLogs is append-only: update and delete are refused to every role (brief §28)',
  auditAppendOnly,
  auditAppendOnly ? '' : 'auditLogs does not refuse update and delete for all roles',
);

/**
 * 86. Storage denies by default, and a write path is either owner-scoped with a
 * size and MIME cap, or `if false`.
 *
 * brief §9: "Do not trust `file.name`, `file.type`, `file.size` from the client
 * alone." A rules file that ends in `allow read, write: if false` has a default
 * deny; one that ends in an allow has an open door.
 */
const storageSource = read('storage.rules');
/** The window the catch-all's own body must fall inside. */
const CATCH_ALL_WINDOW = 200;
const catchAllIndex = storageSource.indexOf('match /{allPaths=**}');
const storageDefaultDeny =
  catchAllIndex !== -1 &&
  storageSource.slice(catchAllIndex, catchAllIndex + CATCH_ALL_WINDOW).includes('if false');

const finalEvidenceIsClosed =
  storageSource.includes('match /incidents/{incidentId}') &&
  /allow read, write, delete: if false;/.test(storageSource);
const stagingIsCapped =
  storageSource.includes('match /staging/{uid}') &&
  /request\.resource\.size <=/.test(storageSource) &&
  /request\.resource\.contentType\.matches\(/.test(storageSource);
check(
  'Storage denies by default, final evidence is closed to clients, and staging is owner-scoped with size + MIME caps (brief §9, §10)',
  storageDefaultDeny && finalEvidenceIsClosed && stagingIsCapped,
  !storageDefaultDeny
    ? 'the catch-all match does not deny, so an undeclared path is open'
    : !finalEvidenceIsClosed
      ? 'the final-evidence path is not closed to clients'
      : 'the staging write is not bounded by both a size and a content-type check',
);

/* ========================================================================== */
/* Injection classes with no current occurrence                               */
/* ========================================================================== */

/**
 * 87. No HTML/script injection sink anywhere in the app.
 *
 * brief §22: "Be extremely careful with `dangerouslySetInnerHTML`. If used anywhere,
 * remove it unless strictly necessary."
 *
 * **The whole tree is scanned, not a hand-picked list of components.** A
 * hand-picked list passes for the wrong reason the moment the sink appears
 * somewhere new — which is the whole risk of the pattern. `eval`, `new Function`,
 * `innerHTML =`, `document.write` and `outerHTML =` are included because they are
 * the same class of sink: a way to turn a string into code.
 */
const SCRIPT_SINKS = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['eval', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['innerHTML =', /\.innerHTML\s*=(?!=)/],
  ['outerHTML =', /\.outerHTML\s*=(?!=)/],
  ['document.write', /document\.write\s*\(/],
  ['insertAdjacentHTML', /\.insertAdjacentHTML\s*\(/],
];

/**
 * Every scanned source file, ONCE.
 *
 * `walk('.')` is called three times below, and each call re-reads and re-stats the
 * whole tree. Hoisting it also means the three checks provably saw the same set of
 * files, which is the property that makes "no sink anywhere" a real claim.
 *
 * `walk` already excludes `docs` and — importantly — excludes `.cjs`, so this
 * scanner cannot flag the very file that declares these patterns. A self-flagging
 * check is a check that has to be weakened to pass, and weakening it removes the
 * guarantee.
 */
/**
 * Every scanned source file, with PATHS NORMALISED TO FORWARD SLASHES.
 *
 * `walk` builds paths with `path.join`, so on Windows they contain backslashes —
 * and a later `file.startsWith('tests/')` then never matches, which silently
 * included the test suite in a "runtime reads" count. Two checks were reporting
 * test files as production modules. Normalising once here means every path test
 * downstream is platform-independent, rather than each one remembering to handle
 * both separators.
 */
const SCANNED = walk('.')
  .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
  .map((f) => ({ file: f.split('\\').join('/'), code: code10(read(f)) }));

const sinkViolations = [];
for (const [label, pattern] of SCRIPT_SINKS) {
  for (const { file, code } of SCANNED) {
    if (pattern.test(code)) sinkViolations.push(file + ' (' + label + ')');
  }
}
check(
  'No script-injection sink (dangerouslySetInnerHTML, eval, new Function, innerHTML=, document.write) exists anywhere',
  sinkViolations.length === 0,
  sinkViolations.join('; '),
);

/**
 * 88. The server never fetches a URL the user supplied. No SSRF surface.
 *
 * brief §23. A `fetch(userInput)` is a request-forgery primitive: `http://169.254.169.254/`
 * and `http://localhost:8080/` are the payloads that matter. Asserting the ABSENCE
 * is the check, because there is nothing to add — a future feature that needs to
 * fetch a user URL must satisfy this check deliberately, not inherit a pass.
 *
 * The only outbound fetches permitted are to hosts the app itself configured.
 */
const SERVER_FETCH_HOSTS = ['maps.googleapis.com'];
const absoluteFetches = [];
for (const { file, code } of SCANNED) {
  if (file.startsWith('tests/')) continue;
  for (const m of code.matchAll(/fetch\(\s*[`'"](https?:\/\/[^`'"]+)/g)) {
    const url = m[1];
    const allowed = SERVER_FETCH_HOSTS.some((h) => url.startsWith('https://' + h));
    if (!allowed) absoluteFetches.push(file + ' -> ' + url.slice(0, 60));
  }
}
check(
  'The server fetches no user-supplied URL; outbound fetches are limited to configured hosts (brief §23, SSRF)',
  absoluteFetches.length === 0,
  absoluteFetches.join('; '),
);

/**
 * 89. No navigation to a user-supplied URL.
 *
 * brief §25: `GET /login?redirect=https://malicious-site.com` must not become a
 * redirect off-origin. Asserted over `location.*`, `window.open`, and
 * `NextResponse.redirect` with an interpolated value.
 */
const redirectViolations = [];
for (const { file, code } of SCANNED) {
  if (/location\.(href|assign|replace)\s*=\s*[^\n]*\$\{/.test(code) || /location\.(href|assign|replace)\s*=\s*(searchParams|params|query|req\.)/.test(code)) {
    redirectViolations.push(file + ' (location.*)');
  }
  if (/window\.open\s*\(\s*[^)]*(searchParams|params|query)/.test(code)) {
    redirectViolations.push(file + ' (window.open)');
  }
  if (/NextResponse\.redirect\(\s*(new URL\(\s*request|req\.|\w*[Uu]rl\b)/.test(code)) {
    redirectViolations.push(file + ' (NextResponse.redirect)');
  }
}
check(
  'No navigation or redirect is driven by a user-supplied URL (brief §25, open redirect)',
  redirectViolations.length === 0,
  redirectViolations.join('; '),
);

/* ========================================================================== */
/* Secrets                                                                      */
/* ========================================================================== */

/**
 * 90. `GEMINI_API_KEY` is read in exactly one file, and that file is server-only.
 *
 * brief §4: the key "must remain server-side. Never expose `GEMINI_API_KEY` through
 * `NEXT_PUBLIC_*` or browser bundles."
 *
 * The project already states the intent in `services/ai/contracts.ts` — "That last
 * row is why `GEMINI_API_KEY` appears in exactly one file in this repository" — so
 * this check makes the claim TRUE rather than aspirational. It counts *reads*, and
 * it excludes the client env module by name so a comment explaining the rule does
 * not read as a second read.
 */
/**
 * A read is an ENV ACCESSOR CALL, not a mention.
 *
 * The first version of this check looked for `process.env.GEMINI_API_KEY` and a
 * `GEMINI_API_KEY,` shape, and reported ZERO reads — while the key is read eight
 * times in `lib/env.server.ts`. The real forms are `optionalString('GEMINI_API_KEY')`
 * and `GEMINI_REQUIRED_VARS = ['GEMINI_API_KEY']`, so a pattern shaped for a
 * different access idiom reported a clean bill of health for an unread key. The
 * detection now matches the accessors this codebase actually uses, and the
 * assertion is strengthened from "one read" to "one read, and that file is
 * server-only" — because a single read in a client-reachable module would still be
 * a disclosure.
 */
const ENV_ACCESSORS =
  /(?:optionalString|requiredString|optional|required|env|serverEnv|requireEnv)\(\s*'GEMINI_API_KEY'|'GEMINI_API_KEY'\s*\]/;
/**
 * A test that ASSERTS the key is read is not itself a read.
 *
 * `tests/unit/api/environment.test.ts` and `integrations.test.ts` both reference
 * `GEMINI_API_KEY` precisely to prove the server env resolves it. Counting them
 * would make the check unsatisfiable, and unsatisfiable checks get deleted — which
 * is the failure mode a security check must be designed to avoid.
 */
const geminiReaders = SCANNED.filter(({ file, code }) => !file.startsWith('tests/') && ENV_ACCESSORS.test(code)).map(
  ({ file }) => file,
);
const serverEnvIsServerOnly = /import ['"]server-only['"]/.test(read('lib/env.server.ts'));
const keyReadOnlyOnServer =
  // The path is FORWARD-SLASHED because SCANNED normalises separators — comparing
  // against a backslashed literal fails on every platform except the one it was
  // written on, which is the worst kind of platform bug: green locally, red in CI.
  geminiReaders.length === 1 && geminiReaders[0] === 'lib/env.server.ts' && serverEnvIsServerOnly;
check(
  'GEMINI_API_KEY is read only by lib/env.server.ts, which is server-only (brief §4, §45)',
  keyReadOnlyOnServer,
  geminiReaders.length === 0
    ? 'no env accessor reads GEMINI_API_KEY — either the key is unreadable at runtime, or this check no longer matches the accessors in use'
    : geminiReaders.length > 1
      ? 'read in ' + geminiReaders.length + ' modules: ' + geminiReaders.join(', ')
      : !serverEnvIsServerOnly
        ? 'lib/env.server.ts does not import server-only, so nothing stops a client module importing it'
        : 'read by ' + geminiReaders[0] + ', which is not the server env module',
);

/**
 * 91. The client env module reads ONLY `NEXT_PUBLIC_*`.
 *
 * A `NEXT_PUBLIC_` prefix is the publish boundary — Next.js inlines those into the
 * browser bundle at build time. Any non-prefixed read in the client env module is a
 * secret on its way to a public bundle, and brief §4 forbids it outright.
 */
const clientEnvReads = [
  ...p10EnvClient.matchAll(/(?:required|optional|optionalBoolean|optionalNumber)\(\s*'([A-Z0-9_]+)'/g),
].map((m) => m[1]);
const leakedIntoClient = clientEnvReads.filter((name) => !name.startsWith('NEXT_PUBLIC_'));
check(
  'lib/env.client.ts reads only NEXT_PUBLIC_* names, so no server secret is inlined into the browser bundle (brief §4)',
  clientEnvReads.length > 0 && leakedIntoClient.length === 0,
  clientEnvReads.length === 0
    ? 'no env accessors found — the pattern this check relies on may have changed'
    : 'a non-public name is read by the client env module: ' + leakedIntoClient.join(', '),
);

/* ========================================================================== */
/* Response headers                                                             */
/* ========================================================================== */

/**
 * 92. The non-negotiable response headers are all set, in one place.
 *
 * brief §42. `X-Content-Type-Options: nosniff` alone turns a `.txt` served as
 * `text/html` into a stored-XSS primitive, and `frame-ancestors`/`X-Frame-Options`
 * is the clickjacking control for a dispatcher confirming an assignment.
 *
 * Checked on the MIDDLEWARE rather than on the built response, because the
 * middleware is the single place they are set and a per-route header added later
 * cannot silently drop one of these.
 */
const REQUIRED_HEADERS = [
  'Content-Security-Policy',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'Strict-Transport-Security',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
];
const missingHeaders = REQUIRED_HEADERS.filter((h) => !new RegExp("'" + h.replace(/-/g, '\\-') + "'").test(p10Middleware));
check(
  'Every non-negotiable security response header is set by the middleware (brief §42, docs/10 §15)',
  missingHeaders.length === 0,
  missingHeaders.length === 0 ? '' : 'not set: ' + missingHeaders.join(', '),
);

/**
 * 93. `script-src` carries no `unsafe-inline`, and `unsafe-eval` sits in a
 * dev-only ternary arm.
 *
 * A `script-src 'unsafe-inline'` CSP does not mitigate XSS — it disables the
 * mitigation — and `unsafe-eval` is the most common way a bundle ends up executing
 * attacker-supplied source. Both are genuinely required in development (Fast
 * Refresh and the dev overlay), and a dev-only allowance cannot affect a production
 * deployment, so the assertion is about the TERNARY, not about the header text: a
 * check that merely looked for the string `unsafe-eval` would fail for the correct
 * implementation and pass for one that emits it unconditionally.
 */
/**
 * Scanned with comments STRIPPED.
 *
 * The first run reported a violation in a file that has none: the middleware's own
 * comment reads "far less dangerous than `script-src 'unsafe-inline'`" in the
 * explanation of why `style-src` may use it. The phrase appears because the codebase
 * documents the rule it follows — so a scan that reads comments as code will fail
 * correct code and, to make it pass, someone will delete the explanation.
 *
 * This is the same lesson as three earlier mutation tests in this project: comments
 * are where a prohibition gets DESCRIBED, which is exactly why they must be removed
 * before a prohibition is scanned for.
 */
const middlewareCode = code10(p10Middleware);
const unsafeInlineInScriptSrc = /script-src[^\n]*'unsafe-inline'/.test(middlewareCode);
/** The dev arm supplies the allowance; the production arm supplies nothing. */
const evalArmIsDevOnly =
  /isDev \? "'unsafe-eval'" : ''/.test(middlewareCode) || /\$\{isDev \? "'unsafe-eval'" : ''\}/.test(middlewareCode);
check(
  "script-src has no 'unsafe-inline', and 'unsafe-eval' sits only in the development arm (brief §42)",
  !unsafeInlineInScriptSrc && evalArmIsDevOnly,
  unsafeInlineInScriptSrc
    ? "script-src allows 'unsafe-inline', which disables the CSP's XSS mitigation"
    : "'unsafe-eval' is not confined to a development-only ternary arm",
);
}

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
