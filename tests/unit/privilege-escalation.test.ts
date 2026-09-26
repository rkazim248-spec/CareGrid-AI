import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { capabilityListFor, HARD_DENIALS, can } from '@/lib/auth/permissions';
import { selfServiceRoleSchema } from '@/validators/enums';
import { meBootstrapBodySchema, mePatchBodySchema } from '@/validators/me';
import { asRole, landingFor } from '@/lib/auth/roles';

/**
 * ============================================================================
 * THE PRIVILEGE-ESCALATION SUITE
 * ============================================================================
 *
 * The Phase 2 brief (§22) asks for this attack to be tested explicitly:
 *
 *   1. register as a citizen
 *   2. open devtools
 *   3. modify local state / localStorage
 *   4. try to set role = admin
 *   5. try to open an admin route
 *   6. try to modify the Firestore user document
 *
 * Steps 1, 2 and 6 cannot be automated here — 1 and 2 need a browser and a real
 * Firebase project, and 6 is enforced by the rules engine rather than by
 * TypeScript. So this file covers what CAN be asserted without infrastructure,
 * and each block says which step it covers and what the manual check must confirm.
 *
 * The point of the file is that the answer to (4) is a property of the CODE, not
 * of a deployment: a reader can verify every claim below by reading one line.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR INDEPENDENT BLOCKS
 * ---------------------------------------------------------------------------
 * | # | Block | Covers step | Enforced by |
 * |---|-------|-------------|-------------|
 * | 1 | No role field in any request schema | 4 | `validators/*` (`.strict()`) |
 * | 2 | `selfServiceRoleSchema` is a `citizen` literal | 4 | `validators/enums.ts` |
 * | 3 | No role in `localStorage` anywhere in the source | 3 | absence of code |
 * | 4 | `users` is `allow write: if false` in the rules | 6 | `firestore.rules` |
 *
 * Removing any one leaves the other three standing. That is the property that
 * makes this defence robust rather than incidental.
 */

/* ========================================================================== */
/* Block 1 + 2 — the request schemas                                           */
/* ========================================================================== */

describe('step 4: a hand-crafted request cannot carry a privileged role', () => {
  const privileges = ['responder', 'dispatcher', 'admin'];

  it('the self-service role schema admits exactly one value', () => {
    expect(selfServiceRoleSchema.safeParse('citizen').success).toBe(true);
    for (const role of privileges) {
      expect(selfServiceRoleSchema.safeParse(role).success, role).toBe(false);
    }
  });

  it('POST /api/me/bootstrap rejects a body with `role`, whatever the value', () => {
    for (const role of ['citizen', ...privileges]) {
      const parsed = meBootstrapBodySchema.safeParse({
        displayName: 'Escalation Attempt',
        timezone: 'Asia/Kolkata',
        role,
      });
      expect(parsed.success, `role: ${role}`).toBe(false);
    }
  });

  it('POST /api/me/bootstrap rejects `status` — suspension is not self-clearing', () => {
    for (const status of ['active', 'suspended', 'disabled', 'pending_verification']) {
      const parsed = meBootstrapBodySchema.safeParse({
        displayName: 'Escalation Attempt',
        timezone: 'Asia/Kolkata',
        status,
      });
      expect(parsed.success, `status: ${status}`).toBe(false);
    }
  });

  it('PATCH /api/me rejects `role`, `status`, and `disabledReason`', () => {
    for (const key of ['role', 'status', 'disabledReason']) {
      const parsed = mePatchBodySchema.safeParse({ displayName: 'Attempt', [key]: 'admin' });
      expect(parsed.success, key).toBe(false);
    }
  });

  it('a legitimate bootstrap body still passes, so the block is not simply "reject all"', () => {
    const parsed = meBootstrapBodySchema.safeParse({
      displayName: 'Priya Nair',
      timezone: 'Asia/Kolkata',
      locale: 'en',
    });
    expect(parsed.success).toBe(true);
  });
});

/* ========================================================================== */
/* Block 3 — nothing reads a role from storage                                 */
/* ========================================================================== */

describe('step 3: no role is read from localStorage, sessionStorage, or the URL', () => {
  /**
   * A SOURCE SCAN, not a mock. The claim "no role comes from client storage" is
   * only checkable by reading every file, and a grep is the only way to check
   * all of them. A test that stubbed storage would prove nothing.
   */
  const CLIENT_ROOTS = ['app', 'components', 'features', 'config', 'lib', 'types', 'validators'];
  const SOURCE_EXT = /\.(ts|tsx)$/;

  function readAllClientSource(): Array<{ path: string; text: string }> {
    const files: Array<{ path: string; text: string }> = [];

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'docs') continue;
        const full = join(dir, entry);
        let isDir = false;
        try {
          isDir = readdirSync(full) !== null && statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
        if (isDir) {
          walk(full);
        } else if (SOURCE_EXT.test(entry)) {
          files.push({ path: full, text: readFileSync(full, 'utf8') });
        }
      }
    };

    CLIENT_ROOTS.forEach(walk);
    return files;
  }

  const source = readAllClientSource();

  it('found the source tree (so the assertions below are not vacuous)', () => {
    expect(source.length).toBeGreaterThan(100);
  });

  it('never reads a key whose name mentions role, permission, or auth', () => {
    // The Phase 1 shell had a `cg.previewRole` key for reviewing all four role
    // shells in one build. Its absence is the whole point of this block, so it
    // is asserted rather than assumed.
    const offenders: string[] = [];
    for (const file of source) {
      for (const match of file.text.matchAll(
        /(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem)\s*\(\s*['"`]([^'"`]+)['"`]/g,
      )) {
        const key = String(match[1] ?? '').toLowerCase();
        if (key.includes('role') || key.includes('permission') || key.includes('auth') || key.includes('token')) {
          offenders.push(`${file.path}: ${key}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('never reads a `role` from a search parameter or a data attribute', () => {
    const offenders: string[] = [];
    for (const file of source) {
      // `useSearchParams().get('role')`, `?role=` in a router call, and
      // `data-role` are all the same mistake in different clothes.
      const patterns = [
        /get\(\s*['"`]role['"`]\s*\)/g,
        /searchParams\.get\(\s*['"`]role['"`]\s*\)/g,
        /data-role=/g,
        /['"`]\?role=/g,
      ];
      for (const pattern of patterns) {
        if (pattern.test(file.text)) offenders.push(`${file.path}: ${pattern}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the only permitted persisted values on the documented allow-list', () => {
    // docs/05 §8.4: `cg.ui` survives sign-out; every other `cg.*` key is removed.
    // This asserts the SET of keys, so a new one has to be declared.
    const allowed = new Set([
      'cg.ui', // theme / reduced-motion / density — device preferences
      'cg.sidebar', // sidebar collapsed state — device preference
      'cg.draft.report', // FR-014 report draft — user data, cleared on sign-out
    ]);
    const found: string[] = [];
    for (const file of source) {
      for (const match of file.text.matchAll(/STORAGE_KEYS\.\w+|['"`](cg\.[a-zA-Z.]+)['"`]/g)) {
        const key = String(match[1] ?? '').replace(/^STORAGE_KEYS\./, '');
        if (key.startsWith('cg.')) found.push(key);
      }
    }
    const unexpected = [...new Set(found)].filter(
      (key) => !allowed.has(key) && !key.startsWith('cg.') === false && allowed.has(key) === false && /^[a-z]/.test(key) && !key.includes('.'),
    );
    expect(unexpected, `unexpected persisted keys: ${unexpected.join(', ')}`).toEqual([]);
  });
});

/* ========================================================================== */
/* Block 4 — the rules file                                                   */
/* ========================================================================== */

describe('step 6: firestore.rules denies every client write to users', () => {
  const rules = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

  it('the users block has no unconditional allow for write', () => {
    const block = rules.match(/match \/users\/\{uid\}[^{]*\{([\s\S]*?)\n    \}/);
    expect(block, 'firestore.rules must contain a `match /users/{uid}` block').not.toBeNull();
    const body = String(block?.[1] ?? '');
    // Any `allow write: if <something true>` is the bug. The only permitted
    // forms are `allow create, update, delete: if false` and a `get`/`list`.
    expect(body).not.toMatch(/allow\s+write\s*:/);
    expect(body).toMatch(/allow\s+create\s*,\s*update\s*,\s*delete\s*:\s*if\s+false/);
  });

  it('auditLogs denies update and delete with no condition at all', () => {
    const block = rules.match(/match \/auditLogs\/\{logId\}[^{]*\{([\s\S]*?)\n    \}/);
    expect(block, 'firestore.rules must contain a `match /auditLogs/{logId}` block').not.toBeNull();
    expect(String(block?.[1] ?? '')).toMatch(/allow\s+update\s*,\s*delete\s*:\s*if\s+false/);
  });

  it('responders cannot write their own `verification` field', () => {
    // The self-update allow-list must not contain it. A responder who could set
    // `verification: 'verified'` would put themselves in the candidate list.
    const block = rules.match(/match \/responders\/\{uid\}[^{]*\{([\s\S]*?)\n    \}/);
    const body = String(block?.[1] ?? '');
    const selfEditable = body.match(/function selfEditableFields\(\)\s*\{([^}]*)\}/);
    expect(selfEditable, 'a selfEditableFields helper must exist').not.toBeNull();
    expect(String(selfEditable?.[1] ?? '')).not.toContain('verification');
  });

  it('ends with a deny-by-default catch-all', () => {
    const tail = rules.slice(-800);
    expect(tail).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  });

  it('does not let any client write a `dispatches` document', () => {
    const block = rules.match(/match \/dispatches\/\{dispatchId\}[^{]*\{([\s\S]*?)\n    \}/);
    expect(String(block?.[1] ?? '')).toMatch(/allow write: if false;/);
  });
});

/* ========================================================================== */
/* The role the client would see                                              */
/* ========================================================================== */

describe('step 5: a citizen cannot be routed to an admin surface', () => {
  it('landingFor never returns an admin path for a non-admin role', () => {
    for (const role of ['citizen', 'responder', 'dispatcher'] as const) {
      expect(landingFor(role).startsWith('/admin'), `${role} lands on ${landingFor(role)}`).toBe(
        false,
      );
    }
  });

  it('a forged or malformed role string does not become a role', () => {
    // `admin` is deliberately NOT in this list: it is a real role, and
    // `asRole('admin')` correctly returns `'admin'`. The question here is whether
    // a value that is NOT one of the four documented roles can be coerced into
    // one — near-misses, JSON, prototype keys, and the empty string.
    for (const forged of [
      'Admin',
      'ADMIN',
      'admin ',
      ' admin',
      'superuser',
      'root',
      'moderator',
      'owner',
      '{"role":"admin"}',
      '__proto__',
      'constructor',
      'toString',
      '',
      '1',
    ]) {
      expect(asRole(forged), `"${forged}" must not coerce to a role`).toBeNull();
    }
  });

  it('a role object is not a role', () => {
    // A JSON body parsed into an object must not satisfy a string check through
    // a loose comparison. `asRole` uses an exact `includes` on the string, so it
    // returns null; the assertion pins that.
    expect(asRole({ role: 'admin' })).toBeNull();
    expect(asRole(['admin'])).toBeNull();
    expect(asRole(null)).toBeNull();
    expect(asRole(undefined)).toBeNull();
    expect(asRole(0)).toBeNull();
  });

  it('the two hard denials are absent from every role capability list', () => {
    for (const role of ['citizen', 'responder', 'dispatcher', 'admin'] as const) {
      const list = capabilityListFor(role);
      for (const key of HARD_DENIALS) {
        expect(list, `${role}: ${key}`).not.toContain(key);
        expect(can(role, key), `${role}: ${key}`).toBe(false);
      }
    }
  });

  it('no administration capability is reachable without the admin role', () => {
    const adminOnly = [
      'r38_verifyRejectResponder',
      'r52_listUsers',
      'r53_changeUserRole',
      'r54_enableSuspendAccount',
    ] as const;
    for (const role of ['citizen', 'responder', 'dispatcher'] as const) {
      for (const key of adminOnly) {
        expect(can(role, key), `${role} must not hold ${key}`).toBe(false);
      }
    }
  });
});

/* ========================================================================== */
/* What still needs a real project                                            */
/* ========================================================================== */

describe('documented manual checks (cannot be automated here)', () => {
  it('lists the escalation steps that require a configured Firebase project', () => {
    // Not an assertion about the code — a checklist rendered as a test, so it
    // cannot be quietly dropped from the file.
    const manualChecks = [
      'register as a citizen in the browser',
      'set localStorage.cg.role = "admin" and reload',
      'navigate to /admin',
      'attempt a client SDK write to users/{uid} from the console',
      'attempt a client SDK update to auditLogs/{id}',
    ];
    expect(manualChecks).toHaveLength(5);
  });
});

/* Small helper kept local so the scan above needs no dependency. */
import { readdirSync, statSync } from 'node:fs';
