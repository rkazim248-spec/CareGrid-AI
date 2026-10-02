/**
 * A build-time-inlining guard for client-reachable env reads.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * Next.js replaces `process.env.NEXT_PUBLIC_FOO` with the literal string at
 * build time, but ONLY when it sees a literal member expression. A computed
 * access — `process.env[name]`, `process.env[key]` — is never rewritten.
 *
 * On the server that mistake is invisible, because Node has a real
 * `process.env` to satisfy it, so the type checker, the unit tests, the server
 * render, and the build all pass. In the client bundle the same lookup hits an
 * empty object and every variable reads `undefined`.
 *
 * That is what happened here. `lib/env.client.ts` read all six Firebase keys via
 * `process.env[name]`, so the browser believed Firebase was unconfigured while
 * `.env.local`, the server-side REST probe, and the whole Firebase project were
 * all perfectly healthy. It surfaced to the user as "Something went wrong. Try
 * again." because a missing config throws an `EnvError` from inside the auth
 * layer, indistinguishable from a real Firebase failure — and it also threw a
 * hydration mismatch on every guarded route.
 *
 * Server-side dynamic access is LEGAL and is used on purpose, so this test
 * asserts on the client-reachable surface only. That boundary is why the bug
 * survived: the offending file was correct by every server-side measure.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Directories that never ship to the browser. */
const SERVER_ONLY = [
  'lib/env.server.ts',
  'lib/server',
  'app/api',
  'middleware.ts',
  'scripts',
  'tests',
  'node_modules',
  '.next',
  '.kilo',
  '.git',
];

/** Roots whose contents are bundled into the client. */
const CLIENT_ROOTS = ['app', 'components', 'features', 'lib', 'hooks', 'services'];
const CLIENT_EXTENSIONS = new Set(['.ts', '.tsx']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.kilo' || entry === '.git') {
      continue;
    }
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, out);
    else if (CLIENT_EXTENSIONS.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

/** `process.env` followed by a `[` — i.e. a computed, non-inlinable lookup. */
const COMPUTED_ENV_ACCESS = /process\.env\s*\[/;

function clientReachableFiles(): string[] {
  const all: string[] = [];
  for (const r of CLIENT_ROOTS) all.push(...walk(join(ROOT, r)));
  // Windows reports `lib\env.server.ts` while the list above is written with
  // forward slashes, so both sides are normalised before comparing. Without
  // this the server-only filter silently matches nothing on win32 and the
  // whole test degrades into flagging legitimate server code.
  const serverOnly = SERVER_ONLY.map((s) => s.replace(/\//g, sep));
  return all.filter((f) => {
    const rel = relative(ROOT, f).replace(/\//g, sep);
    return !serverOnly.some((s) => rel === s || rel.startsWith(s + sep));
  });
}

describe('client env reads are statically inlinable', () => {
  const files = clientReachableFiles();

  it('actually inspected files, so a broken glob cannot pass silently', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.replace(/\//g, sep).endsWith(join('lib', 'env.client.ts')))).toBe(true);

  });

  it('no client-reachable file uses a computed process.env[...] lookup', () => {
    const offenders: string[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      source.split('\n').forEach((line, i) => {
        // Ignore prose in comments: the explanatory notes about this very bug
        // legitimately quote `process.env[name]`.
        const withoutStrings = line.replace(/'[^']*'/g, '').replace(/`[^`]*`/g, '');
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
        if (COMPUTED_ENV_ACCESS.test(withoutStrings)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Computed process.env[...] reads cannot be inlined by Next.js and always read undefined in the browser:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('lib/env.client.ts reads every public variable as a literal member expression', () => {
    const source = readFileSync(join(ROOT, 'lib', 'env.client.ts'), 'utf8');
    const declared = [
      'NEXT_PUBLIC_APP_ENV',
      'NEXT_PUBLIC_APP_URL',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_USE_EMULATORS',
      'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
      'NEXT_PUBLIC_MAP_STYLE',
      'NEXT_PUBLIC_MAP_STYLE_ID',
      'NEXT_PUBLIC_MAP_ZOOM_DEFAULT',
      'NEXT_PUBLIC_MAP_ZOOM_MAX',
      'NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN',
    ];

    const missing = declared.filter((name) => !source.includes(`process.env.${name}`));
    expect(
      missing,
      'These public variables are never read as a literal `process.env.NAME`, so they are invisible to the bundler.',
    ).toEqual([]);

    // Every Firebase key the app needs must be in the snapshot, or the browser
    // concludes Firebase is unconfigured and refuses to authenticate anyone.
    const firebaseKeys = declared.filter((n) => n.startsWith('NEXT_PUBLIC_FIREBASE_'));
    expect(firebaseKeys.length).toBe(7);
  });
});

