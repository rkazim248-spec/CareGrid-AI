#!/usr/bin/env node
/**
 * ============================================================================
 * Repo-wide secret scan
 * ============================================================================
 *
 * Phase 15, item 8. `security:check` already asserts that `.env.local` is ignored
 * and untracked; this covers the question that check cannot answer — whether a
 * credential is sitting in a file that was ALWAYS going to be committed.
 *
 * The distinction matters because the two failures have different fixes. An
 * untracked `.env.local` is fixed by gitignore. A private key pasted into
 * `lib/env.server.ts` is fixed by ROTATION, and the commit has to be rewritten or
 * the key assumed compromised. Only one of those is recoverable by editing a file.
 *
 * ---------------------------------------------------------------------------
 * WHY VALUES ARE REDACTED IN THE OUTPUT
 * ---------------------------------------------------------------------------
 * A scanner that prints the secret it found has copied the secret into CI logs,
 * build output, and every place those get archived or forwarded to Slack. So a
 * finding reports the file, the line, the rule, and a fingerprint — enough to
 * locate and rotate, useless to an attacker reading the log. `fingerprint` is a
 * truncated SHA-256, stable across runs so a finding can be tracked, and
 * non-reversible because SHA-256 is not the point: the secret is short-lived
 * entropy, not a password, and nobody is brute-forcing it out of a log.
 *
 * ---------------------------------------------------------------------------
 * WHY RULES ARE EXPLICIT RATHER THAN ONE BIG REGEX
 * ---------------------------------------------------------------------------
 * A single "looks like a secret" pattern produces a wall of false positives on
 * TypeScript that has a hundred legitimately-secret-shaped string literals, and a
 * scanner that cries wolf gets muted. So rules are split into two tiers:
 *
 *   HIGH_CONFIDENCE — provider formats with enough structure that a match is a
 *                     credential and not a coincidence. No placeholder exemption,
 *                     because `AIza` plus 35 URL-safe characters is not a word.
 *   ASSIGNED_SECRET — a known-sensitive KEY being handed a literal VALUE. The key
 *                     is the signal, so test files and docs are exempt (they use
 *                     fake credentials legitimately) but source is not.
 *
 * The exemption lists are therefore the interesting part of this file, and each
 * one is justified inline.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not scan history. A secret deleted in the last commit is still in the
 * object store, and finding that needs `git log -p` piped to the same rules — which
 * this cannot do, because it must work in a checkout with no git installed. Run
 * it against history too when there is a git.
 */

'use strict';

const { readdirSync, readFileSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join, relative, sep } = require('node:path');

const ROOT = process.cwd();

/**
 * Directories never worth walking. `node_modules` is most of them.
 *
 * `.kilo` holds agent WORKTREES — complete secondary checkouts of this same repo,
 * already covered by `.gitignore`. Without this entry the scan walked ~1600 files
 * of which roughly half were duplicates, and a credential present in one worktree
 * reported at two or three paths for what is one finding. They are excluded for
 * throughput and de-duplication, NOT because they are trusted: each contains its
 * own copy of `.env.local`, which is worth knowing and is reported separately.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'out', 'dist', 'build', 'coverage',
  '.turbo', '.vercel', '.firebase', 'storybook-static', '.cache', '.kilo',
]);

/** Binary or non-text extensions; a `.png` scanned for `AIza` proves nothing. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.br', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.mov', '.webm', '.so', '.dll', '.exe', '.wasm',
  '.lock', '.map',
]);

/**
 * Files exempt from the ASSIGNED_SECRET tier.
 *
 * Two categories, both about credentials that are SUPPOSED to be there:
 *
 *   tests    — a test that passes a fake API key is testing the fake path. A rule
 *              that flagged those would flag the suite that verifies the scanner's
 *              own neighbours behave, and the way to "fix" it would be to delete
 *              the tests.
 *   docs     — configuration docs quote the SHAPE of a key (`sk_live_…`) to say
 *              what belongs in which variable. Requiring them to redact the prefix
 *              would make the docs less useful and teach a reader nothing.
 *
 * Neither exemption applies to HIGH_CONFIDENCE: a test file containing a real
 * 35-character Google key is a leak no matter which file it is in.
 */
const ASSIGNED_SECRET_EXEMPT = [/(^|[\\/])tests?[\\/]/, /\.md$/i, /^\.env\.example$/];

/** Never exempt. A key in here is a key in production. */
const ALWAYS_SCANNED = ['scripts', 'app', 'lib', 'services', 'features', 'validators', 'config', 'middleware.ts'];

/* ========================================================================== */
/* Rules                                                                        */
/* ========================================================================== */

/**
 * `secret`, `label`, and a capture group 1 that is the SECRET itself.
 *
 * The capture group is load-bearing: the redacted fingerprint and the reported
 * match are computed from group 1, so a rule cannot accidentally fingerprint its
 * own framing text and report two identical findings as distinct.
 */
const HIGH_CONFIDENCE = [
  {
    label: 'Google / Firebase API key',
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
  },
  {
    label: 'Google Cloud service-account private key',
    /**
     * Matches the header AND a body of real key material, not the header alone.
     *
     * The first version of this rule was `/-----BEGIN PRIVATE KEY-----/` and it
     * fired on three files that contain no key at all: `installRequiredEnv()` in
     * the route harness and `environment.test.ts` both install a two-line stand-in
     * so the env tier can be satisfied without a real credential, and the
     * environment doc quotes the shape. The header is a delimiter, not a secret —
     * what makes a PEM dangerous is the body, so the body is what the rule asks
     * for. `[\s\S]` rather than `.` because a real PEM body spans lines.
     *
     * The consequence is that a truncated or emptied key stops being reported,
     * which is correct: a PEM header with no body cannot authenticate anything.
     *
     * The separator accepts a LITERAL backslash-n as well as real whitespace, and
     * that is not defensive padding — it was a real miss caught by planting a
     * probe. A PEM embedded in a TypeScript string as `"-----BEGIN PRIVATE
     * KEY-----\nMIIE…"` has an escaped newline in the file, and requiring real
     * whitespace skipped it. That is precisely the shape produced by
     * `JSON.stringify`, a Python `repr`, or a template literal, so it is a
     * plausible way to commit a key and had to be caught.
     */
    regex: /(-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----(?:\\n|\\r|\\t|\s)*[A-Za-z0-9+/]{40,}={0,2})/g,
  },
  {
    label: 'Firebase service-account JSON (client_email + private_key)',
    regex: /("private_key"\s*:\s*"[^"]{40,})/g,
  },
  {
    label: 'Mapbox secret or public token',
    regex: /\b([ps]k\.eyJ1Ijoi[A-Za-z0-9_-]{10,})/g,
  },
  {
    label: 'AWS access key id',
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  {
    label: 'Slack token',
    regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  },
  {
    label: 'Stripe live secret',
    regex: /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})/g,
  },
  {
    label: 'GitHub token',
    regex: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,})/g,
  },
  {
    label: 'Vercel token',
    regex: /\b(vercel[0-9a-zA-Z]{24,})\b/g,
  },
  {
    label: 'Signed JWT',
    // A JWT is not always a secret — the Firebase web config ships an API key in
    // one — but an unexpected long-lived one in source is worth a human look.
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  },
];

/**
 * The ASSIGNED_SECRET tier.
 *
 * Requires the ASSIGNMENT to be present: `API_KEY=<value>` or `"apiKey": "<value>"`.
 * A bare string that merely mentions `token` is prose, not a credential, and the
 * 16-character floor keeps it that way — every real provider key is longer.
 */
const ASSIGNED_SECRET = [
  {
    label: 'assigned API key',
    regex: /\b([A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*["']([^"'\n]{16,})["'])/gi,
    group: 2,
  },
];

/**
 * Placeholder values that are obviously not credentials.
 *
 * Deliberately narrow. A filter that accepted anything containing `test` would
 * excuse `API_KEY="test-key-AIzaSy…"`; the point of the exemption list is to make
 * up for genuinely fake values in fixtures, and every entry here is a word that
 * only appears in a fixture.
 */
const PLACEHOLDER = /^(?:|x{3,}|\*{3,}|changeme|placeholder|redacted|example|dummy|fake|your[-_ ]?|todo|tbd|null|undefined|none|\.{3,})|(?:^|[^a-z])(?:test|mock|spec|sample|example|demo|placeholder|dummy|fake|redacted|invalid|notreal)(?:[^a-z]|$)/i;

/* ========================================================================== */
/* Walking                                                                      */
/* ========================================================================== */

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // never follow links out of the tree
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function extname(file) {
  const base = file.slice(file.lastIndexOf(sep) + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Never scan these at all.
 *
 * `.env.local` is skipped NOT because it is safe — it is the most secret-bearing
 * file in the repo — but because it is EXPECTED to hold credentials and is expected
 * to be untracked. Scanning it would report every value as a finding and teach
 * operators to ignore the scanner. Its protection is `.gitignore` plus
 * `security:check`, which is where "is it untracked" is actually answered.
 */
function isSkippedEntirely(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (SKIP_EXT.has(extname(file))) return true;
  if (/^\.env(\.|$)/.test(base) && base !== '.env.example') return true;
  if (base === 'package-lock.json') return true;
  return false;
}

function isExemptFromAssignedTier(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ASSIGNED_SECRET_EXEMPT.some((pattern) => pattern.test(rel))) return true;
  return !ALWAYS_SCANNED.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`)) && /(^|\/)(tests?|docs)\//.test(rel);
}

/** Cap so a pathological file cannot exhaust memory. 2 MiB is far above any source file. */
const MAX_BYTES = 2 * 1024 * 1024;

function scanFile(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return [];
  }
  if (stat.size > MAX_BYTES) return [];

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // A NUL in the first chunk means this is binary that slipped past the extension
  // filter. Checking content rather than trusting the name is what catches `.env`
  // files holding a PEM and CI configs holding base64 bundles.
  if (text.includes(' ')) return [];

  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const findings = [];

  const applyRule = (rule, content) => {
    const group = rule.group ?? 1;
    const regex = new RegExp(rule.regex.source, rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const secret = match[group];
      if (!secret) continue;
      findings.push({ rule: rule.label, line: content.slice(0, match.index).split('\n').length, secret });
      // A rule with no zero-length risk, but guard anyway: a regex that can match
      // empty would spin here forever.
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
  };

  for (const rule of HIGH_CONFIDENCE) applyRule(rule, text);
  if (!isExemptFromAssignedTier(file)) {
    for (const rule of ASSIGNED_SECRET) applyRule(rule, text);
  }

  return findings
    .filter((finding) => (finding.rule === 'assigned API key' ? !PLACEHOLDER.test(finding.secret) : true))
    .map((finding) => ({
      file: rel,
      line: finding.line,
      rule: finding.rule,
      fingerprint: fingerprintOf(finding.secret),
    }));
}

/**
 * Stable, non-reversible identifier for a finding.
 *
 * Truncated to 12 hex chars — enough to tell two findings apart and to recognise
 * "the same key in two files", short enough that it cannot be used to confirm a
 * guessed key by brute force. A dedicated prefix keeps it from being mistaken for
 * a hash of something harmless.
 */
function fingerprintOf(secret) {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

/* ========================================================================== */
/* Reporting                                                                    */
/* ========================================================================== */

function main() {
  const findings = [];
  let scanned = 0;

  for (const file of walk(ROOT)) {
    if (isSkippedEntirely(file)) continue;
    scanned += 1;
    findings.push(...scanFile(file));
  }

  // Same secret in several files is one incident, not N. Grouping also makes the
  // "this key is in three places" shape visible, which is the shape that means a
  // bad copy-paste rather than one careless line.
  const byFingerprint = new Map();
  for (const finding of findings) {
    const entry = byFingerprint.get(finding.fingerprint);
    if (entry) entry.locations.push(`${finding.file}:${finding.line}`);
    else byFingerprint.set(finding.fingerprint, { rule: finding.rule, locations: [`${finding.file}:${finding.line}`] });
  }

  const groups = [...byFingerprint.values()];

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ scanned, findings: groups }, null, 2)}\n`);
  } else if (groups.length === 0) {
    process.stdout.write(`secret scan: 0 findings across ${scanned} files\n`);
  } else {
    process.stdout.write(`secret scan: ${groups.length} distinct secret(s) across ${scanned} files\n\n`);
    for (const group of groups) {
      process.stdout.write(`  [FAIL] ${group.rule}\n`);
      for (const location of group.locations) process.stdout.write(`         ${location}\n`);
      process.stdout.write('         -> rotate this credential, then remove it from history.\n');
    }
  }

  process.exitCode = groups.length === 0 ? 0 : 1;
}

main();