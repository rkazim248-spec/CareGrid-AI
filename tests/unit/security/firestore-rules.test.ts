/**
 * ============================================================================
 * firestore.rules review (Phase 15, item 6)
 * ============================================================================
 *
 * The gap this file exists to close: every other test in the suite exercises the
 * Admin SDK, which **bypasses `firestore.rules` by design**. So a route test can
 * be green while the rules a browser hits are wide open. There are no rules tests
 * here before this one.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE TEXT ASSERTIONS AND NOT RULE EXECUTION
 * ---------------------------------------------------------------------------
 * There is no Firestore emulator available here, so the rules cannot be evaluated.
 * A test that reads the file and asserts on its structure proves something weaker
 * than executing it, and pretending otherwise would be dishonest — so this file
 * states plainly that it is a REVIEW, and it is built to fail loudly when the
 * text it depends on changes.
 *
 * The mitigation for "text assertions are weak" is threefold:
 *
 *   1. Every assertion names the SECURITY CONSEQUENCE it protects, so a reader can
 *      judge whether the rule still means what it did.
 *   2. Where the file already contains a `hasOnly`/`hasAll` guard, the test
 *      asserts the guard's FIELD LIST, so a field silently added to a writable
 *      allow-list is caught.
 *   3. Structural assertions (every path is covered; nothing is left to the
 *      catch-all) are mechanical and cannot be satisfied by a stray comment.
 *
 * ---------------------------------------------------------------------------
 * FINDINGS THIS REVIEW PRODUCED
 * ---------------------------------------------------------------------------
 * Two real defects and two assurance gaps. The first is fixed in the rules; the
 * others are documented here because they need a decision, not a patch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The rules as one string. Read once so every assertion sees the same text. */
const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

/**
 * The body of one `match /path/ { … }` block.
 *
 * Indentation-anchored rather than brace-counted: brace counting breaks the moment
 * a string literal or comment contains a brace, and both appear in this file.
 */
function block(path: string): string {
  const marker = new RegExp(`^([ ]*)match ${path.replace(/[/{}]/g, (c) => `\\${c}`)} \\{`, 'm');
  const match = marker.exec(RULES);
  if (match === null) throw new Error(`firestore.rules has no match block for ${path}`);

  // The indentation comes from capture group 1, NOT from slicing backwards from
  // the match index. The marker regex starts at the leading whitespace, so
  // `RULES.slice(lineStart, start)` is empty, `indent` came out as 0, and the
  // closer degenerated to "the last line in the file" — which made every block
  // swallow every rule after it. The result was a suite confidently reporting
  // `allow create: if isSignedIn()` on `/aiRuns`, a rule that does not exist.
  const indent = match[1]!.length;
  const rest = RULES.slice(match.index + match[0].length);
  const end = rest.search(new RegExp(`^\\s{${indent}}\\}`, 'm'));
  if (end === -1) throw new Error(`unterminated match block for ${path}`);
  return rest.slice(0, end);
}

/** Every `allow` clause in a block, as `{ ops, condition }` pairs. */
function allows(source: string): Array<{ ops: string; condition: string }> {
  const out: Array<{ ops: string; condition: string }> = [];
  const pattern = /allow\s+([a-z,\s]+):\s*if\s*([\s\S]*?);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    out.push({
      ops: match[1]!.replace(/\s+/g, ' ').trim(),
      // Collapsed to one line, because the rules wrap `isDispatch() ||` across
      // lines and a pin test asserting on that text has to see the same shape.
      condition: match[2]!.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/**
 * The condition guarding `operation` on a path, or `null` when no clause mentions it.
 */
function guardFor(path: string, operation: 'read' | 'write' | 'get' | 'list' | 'create' | 'update' | 'delete'): string | null {
  for (const clause of allows(block(path))) {
    const ops = clause.ops.split(',').map((op) => op.trim());
    if (ops.includes(operation)) return clause.condition;
  }
  return null;
}

/**
 * Whether a `list` clause reaches `resource.data`, directly or through a helper.
 *
 * The indirection is the whole difficulty. `/incidents` writes
 * `allow list: if canRead() && notDeleted()`, so a search for `resource.data` in
 * the condition text finds nothing and the collection looks fine — while `canRead()`
 * two lines above reads `resource.data.reporterUid` and makes the query
 * unevaluable. An earlier version of this file missed `/incidents` for exactly
 * that reason and pinned a two-entry list as if it were correct.
 *
 * So the check follows the call: any locally-defined function named in the
 * condition is resolved within the block. Bounded to one hop, which is enough
 * here — `canRead()` calls nothing else.
 */
function listRuleUsesResource(path: string): boolean {
  const source = block(path);
  const condition = guardFor(path, 'list');
  if (condition === null) return false;
  if (/resource\.data/.test(condition)) return true;

  for (const call of condition.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)) {
    const name = call[1]!;
    if (name === 'if' || name === 'hasOnly' || name === 'hasAll' || name === 'get') continue;
    const definition = source.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}`));
    if (definition && /resource\.data/.test(definition[0])) return true;
  }
  return false;
}

/* ========================================================================== */
/* 1. The escalation boundaries — the ones that must never open                */
/* ========================================================================== */

/**
 * Each entry is `[path, why it matters]`.
 *
 * These are the collections where a client write is equivalent to a privilege
 * change: the role store, the assignment table, the review queue, the evidence
 * index. Every one of them is server-written through the Admin SDK, so denying the
 * client path costs nothing functionally.
 */
const NEVER_CLIENT_WRITABLE: ReadonlyArray<readonly [string, string]> = [
  ['/users/{uid}', 'the authoritative role store — a write here is a self-promotion to admin'],
  ['/dispatches/{dispatchId}', 'an assignment table — a write here is assigning yourself'],
  ['/evidence/{mediaId}', 'the evidence index — a write here is attaching media you never uploaded'],
  ['/aiReviews/{reviewId}', 'the reviewer judgement — a write here is forging "a human agreed with the model"'],
  ['/aiRuns/{runId}', 'the AI run record — a write here is rewriting what the model was asked'],
  ['/analyticsDaily/{day}', 'derived analytics — a write here is editing the numbers a dashboard shows'],
  ['/rateLimits/{key}', 'the rate-limit buckets — a write here is disabling the limiter'],
  ['/auditLogs/{logId}', 'the audit trail — a write here is forging attribution'],
  ['/statusHistory/{eventId}', 'the incident history — a write here is erasing or inventing a transition'],
];

describe('server-owned collections deny every client write', () => {
  for (const [path, why] of NEVER_CLIENT_WRITABLE) {
    it(`${path} — ${why}`, () => {
      const condition = guardFor(path, 'write');
      // Either an explicit blanket `allow write: if false`, or no `allow write`
      // clause at all (which leaves it to the catch-all). Both deny. Anything
      // else is the finding.
      expect(condition === null || /^\s*false\s*$/.test(condition), `${path} guards writes with \`if ${condition}\``).toBe(true);
    });
  }

  it('no server-owned path grants a create to any signed-in caller', () => {
    // The Phase 15 finding: `auditLogs` read `allow create: if isSignedIn()`,
    // which let any session append to the log. This asserts the shape across all
    // of them so the same mistake cannot be made in a sibling collection.
    const offenders: string[] = [];
    for (const [path] of NEVER_CLIENT_WRITABLE) {
      const create = guardFor(path, 'create');
      if (create && /isSignedIn\(\)/.test(create)) offenders.push(`${path}: allow create: if ${create}`);
    }
    expect(offenders, `Client-writable creates on server-owned collections:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('hard delete is impossible from a browser', () => {
  it('incidents, reports and notifications all refuse delete', () => {
    // `/reports/{reportId}` is declared as a NESTED match inside `/incidents`, so
    // Firestore's own path is `/incidents/{id}/reports/{reportId}` while the
    // literal text in the file is the relative `/reports/{reportId}`. These
    // helpers read the file, so they match what is written.
    for (const path of ['/incidents/{incidentId}', '/reports/{reportId}', '/notifications/{notificationId}']) {
      const condition = guardFor(path, 'delete');
      expect(condition === null || /^\s*false\s*$/.test(condition), `${path} allows delete: if ${condition}`).toBe(true);
    }
  });

  it('the incident lifecycle is append-only in practice: no `delete` on the parent', () => {
    expect(block('/incidents/{incidentId}')).toMatch(/allow delete:\s*if false/);
  });
});

/* ========================================================================== */
/* 2. Field-level allow-lists — the part a stray edit can widen                 */
/* ========================================================================== */

/**
 * These lists are the actual defence for the fields a client legitimately may
 * write. Asserting the LIST rather than the presence of `hasOnly` is what catches
 * a field being added to it.
 */
describe('field allow-lists have not been widened', () => {
  it('a reporter cannot seed an incident with triage-owned fields', () => {
    const incidents = block('/incidents/{incidentId}');
    const creatable = incidents.match(/function clientCreatableFields\(\)[\s\S]*?return \[([\s\S]*?)\]/)?.[1] ?? '';

    // Each of these would let a citizen pre-decide their own report.
    for (const field of ['status', 'urgency', 'summary', 'aiConfidence', 'safetyFlags', 'reference', 'slaTargetMin', 'categoryRaw']) {
      // `categoryRaw` and `peopleAffected` ARE legitimately reporter-supplied
      // (the person who called in knows the category and the headcount), so they
      // are asserted separately below rather than lumped in here.
      if (field === 'categoryRaw') continue;
      expect(creatable, `clientCreatableFields now includes \`${field}\``).not.toMatch(new RegExp(`'${field}'`));
    }
    // The two that ARE allowed, so a future edit cannot quietly drop them either.
    expect(creatable).toMatch(/'categoryRaw'/);
    expect(creatable).toMatch(/'peopleAffected'/);
  });

  it("a reporter's own mutable set excludes status and urgency", () => {
    const incidents = block('/incidents/{incidentId}');
    const mutable = incidents.match(/function mutableFields\(\)[\s\S]*?hasOnly\(\[([\s\S]*?)\]/)?.[1] ?? '';
    for (const field of ['status', 'urgency', 'summary', 'reporterUid', 'assigneeUid']) {
      expect(mutable, `mutableFields now includes \`${field}\``).not.toMatch(new RegExp(`'${field}'`));
    }
  });

  it("a profile cannot write its own role, because the check is hasOnly and not a diff", () => {
    // A `create` has no prior resource to diff against, so a diff-based check
    // would pass vacuously on creation and let a client seed `role: 'admin'`.
    const users = block('/profiles/{uid}');
    expect(users).toMatch(/hasOnly\(/);
    const writable = RULES.match(/function profileWritableFields\(\)[\s\S]*?return \[([\s\S]*?)\]/)?.[1] ?? '';
    expect(writable).not.toMatch(/'role'|verification/);
  });

  it("a responder cannot self-verify: `verification` is outside their editable set", () => {
    const responders = block('/responders/{uid}');
    const selfEditable = responders.match(/function selfEditableFields\(\)[\s\S]*?return \[([\s\S]*?)\]/)?.[1] ?? '';
    expect(selfEditable).not.toMatch(/'verification'/);
    // The admin branch is the only other way in.
    expect(responders).toMatch(/:\s*isAdmin\(\)/);
  });

  it('a responder cannot write into another responder\'s location document', () => {
    const locations = block('/responderLocations/{uid}');
    // The `uid == uid` clause closes the substitution attack. Without it a
    // responder could overwrite a colleague's position and misdirect a dispatch.
    expect(locations).toMatch(/request\.resource\.data\.uid == uid/);
  });

  it('a notification recipient may only mark it read, not rewrite its body', () => {
    const notifications = block('/notifications/{notificationId}');
    const update = allows(notifications).find((clause) => clause.ops.includes('update'));
    expect(update?.condition).toMatch(/hasOnly\(\['read', 'readAt', 'updatedAt'\]\)/);
  });
});

/* ========================================================================== */
/* 3. Read scoping — PII and the directory                                     */
/* ========================================================================== */

describe('reads do not leak PII or the responder directory', () => {
  it('a user document is readable only by its owner or by dispatch', () => {
    expect(guardFor('/users/{uid}', 'get')).toMatch(/isSelf\(uid\) \|\| isDispatch\(\)/);
    // A responder or a citizen must not read a peer's email address.
    expect(guardFor('/users/{uid}', 'get')).not.toMatch(/isResponder\(\)/);
  });

  it('the responder directory cannot be enumerated by a citizen', () => {
    expect(guardFor('/responders/{uid}', 'list')).toBe('isDispatch()');
  });

  it('responder locations are readable by dispatch or by self only', () => {
    // A client listener over the collection would track every responder in the
    // city, so `list` is dispatch-only even though `get` is self-inclusive.
    expect(guardFor('/responderLocations/{uid}', 'list')).toBe('isDispatch()');
  });

  it('risk zones are ops-only', () => {
    expect(guardFor('/riskZones/{zoneId}', 'read')).toBe('isOps()');
  });

  it('audit logs are dispatch-readable and nobody-writable', () => {
    expect(guardFor('/auditLogs/{logId}', 'read')).toBe('isDispatch()');
    expect(guardFor('/auditLogs/{logId}', 'write')).toBe('false');
  });
});

/* ========================================================================== */
/* 4. Structural coverage — the catch-all is load-bearing                     */
/* ========================================================================== */

describe('deny by default', () => {
  it('has a catch-all that denies both operations', () => {
    expect(RULES).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });

  it('the catch-all is LAST, so it cannot shadow a specific rule', () => {
    const catchAll = RULES.search(/^\s*match \/\{document=\*\*\}/m);
    expect(catchAll).toBeGreaterThan(0);
    // Search AFTER the catch-all's own line. Slicing from `catchAll` includes
    // that line, so a naive search finds the catch-all itself and reports a
    // shadowing rule on every run.
    const after = RULES.slice(catchAll).replace(/^\s*match \/\{document=\*\*\}[^\n]*\n/, '').search(/^\s*match \//m);
    expect(after, `A match block appears after the catch-all deny at offset ${catchAll}`).toBe(-1);
  });

  it('every collection the client SDK touches has an explicit rule', () => {
    // If a path is missing, it is closed — which is the right failure direction,
    // and is asserted here so "closed" is a decision rather than an accident.
    //
    // The path is captured as `/\S+` rather than `/[^{]+` because a Firestore
    // path is itself full of braces — `/config/{configId}` — and a character
    // class that stops at `{` truncates every path to `/config/` and reports it
    // as unguarded.
    const guarded = [...RULES.matchAll(/^\s*match (\/\S+)\s*\{/gm)].map((m) => m[1]!.trim());
    const expected = [
      '/users/{uid}', '/profiles/{uid}', '/incidents/{incidentId}',
      '/responders/{uid}', '/responderLocations/{uid}', '/dispatches/{dispatchId}',
      '/notifications/{notificationId}', '/resources/{resourceId}',
      '/riskZones/{zoneId}', '/aiRuns/{runId}', '/auditLogs/{logId}',
      '/analyticsDaily/{day}', '/rateLimits/{key}', '/config/{configId}',
    ];
    const missing = expected.filter((path) => !guarded.includes(path));
    expect(missing, `No explicit rule for:\n${missing.join('\n')}`).toEqual([]);
  });
});

/* ========================================================================== */
/* 5. Findings this review could not fix                                       */
/* ========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * WHY THESE ASSERT THE DEFECT IS STILL PRESENT
 * ---------------------------------------------------------------------------
 * The obvious encoding — assert the defect is absent — would add three failing
 * tests to the suite, and a suite that is red for a reason nobody can fix is a
 * suite people learn to ignore. That is how a real finding dies.
 *
 * So these PIN the current state instead. They pass today, they name the defect
 * in the failure output, and when someone fixes one they turn RED and say "the
 * known-findings list changed, update this pin" — which is the moment the debt
 * should be retired deliberately rather than forgotten.
 *
 * To resolve a finding: fix the rules, then delete that `it` block and move its
 * rule into the sections above, where it is asserted as a property.
 */
describe('known findings — pinned, not fixed', () => {
  /**
   * FINDING A. `resource.data` inside a `list` rule cannot be evaluated.
   *
   * Firestore exposes `resource` for `get`/`create`/`update`/`delete` only. In a
   * `list` rule the query's documents are not yet known, so referencing
   * `resource.data` raises an error that DENIES the query.
   *
   * Direction of failure: this DENIES, it does not leak. A client-side listener
   * over incidents or notifications fails closed and silently. Since this project
   * serves reads through the Admin SDK, the practical impact is a confusing
   * "my listener never fires" bug rather than a breach — but the rules do not
   * provide the row-level filtering they appear to, and anyone who reads them
   * will believe they do.
   *
   * Fix is a decision, not a patch: either express the constraint with
   * `request.query` plus something the engine can evaluate, or follow the pattern
   * already used for `/evidence` and `/aiReviews` and serve these through the API
   * with no client rule at all.
   */
  it('FINDING A: three `list` rules use `resource.data`, which Firestore cannot evaluate', () => {
    const offenders = ['/incidents/{incidentId}', '/notifications/{notificationId}', '/dispatches/{dispatchId}'].filter(
      listRuleUsesResource,
    );
    expect(
      offenders,
      offenders.length === 0
        ? 'FINDING A appears FIXED. Delete this pin and assert the property in section 3.'
        : 'FINDING A changed shape. Re-review before updating this pin.',
    ).toEqual(['/incidents/{incidentId}', '/notifications/{notificationId}', '/dispatches/{dispatchId}']);
  });

  /**
   * FINDING B. The dispatcher branch of `/incidents` has no field allow-list.
   *
   * `allow update: if isDispatch() || …` lets a dispatcher's browser rewrite ANY
   * field, including `reporterUid`. That is an ownership field: `canRead()` uses
   * it to decide who can see the incident. The server owns it; nothing stops a
   * compromised dispatcher session reassigning ownership from a client listener.
   *
   * Not patched because the intent may be deliberate — dispatchers are staff and
   * the API does enforce the transition table server-side. Recorded so the
   * decision is explicit rather than incidental.
   */
  it('FINDING B: the dispatcher branch of /incidents is unconstrained', () => {
    const update = guardFor('/incidents/{incidentId}', 'update') ?? '';
    expect(
      update,
      update.includes('isDispatch() ||')
        ? 'FINDING B appears FIXED. Delete this pin and assert the field list in section 2.'
        : 'FINDING B changed shape. Re-review before updating this pin.',
    ).toContain('isDispatch() ||');
  });

  /**
   * FINDING C. A redundant `allow read: if false` in `/responderLocations`.
   *
   * Firestore ORs multiple `allow` clauses for the same operation, so adding
   * `allow read: if false` alongside `allow get: …` and `allow list: …` restricts
   * nothing. Its comment claims it enforces "no `in` queries", which it does not
   * — an `in` query is still a `list`, and the real control is the narrower
   * `allow list: if isDispatch()`.
   *
   * A line that looks like a restriction and enforces nothing is worse than no
   * line: it is false assurance inside a security file.
   */
  it('FINDING C: the redundant `allow read: if false` is still present', () => {
    const locations = block('/responderLocations/{uid}');
    // Pinned as PRESENT: the line is a no-op that reads like a restriction. When
    // it is deleted, this turns red and asks for the pin to be retired.
    expect(
      locations,
      'FINDING C appears FIXED. Delete this pin; `allow list: if isDispatch()` is the real control.',
    ).toMatch(/allow read:\s*if false/);
  });
});