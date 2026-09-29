/**
 * ============================================================================
 * CareGrid AI — snapshot merging
 * ============================================================================
 *
 * `docs/11 §3.4` M-1 … M-4. **PURE.** No Firestore, no React.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MERGE IS NOT "REPLACE THE ARRAY"
 * ---------------------------------------------------------------------------
 * A naive `setItems(snap.docs)` is correct in the steady state and wrong in three
 * cases that all happen during a shift:
 *
 * 1. A local write that the server has not yet acknowledged would be reverted for
 *    a frame, then re-applied — a visible flicker on the row a responder just
 *    pressed "Accept" on.
 * 2. A row that leaves the result set (its filter stopped matching, or it was
 *    resolved) must be REMOVED, not left behind as a stale card. A resolved
 *    incident still in the live queue is the single most confusing thing this UI
 *    could show a dispatcher.
 * 3. An incident that changes must be identifiable, so the row can flash — and
 *    that identification has to exclude the row that is merely being written.
 *
 * ---------------------------------------------------------------------------
 * M-1: A PENDING DOCUMENT REPLACES, NEVER MERGES FIELD-BY-FIELD
 * ---------------------------------------------------------------------------
 * > A pending document **replaces** the server value in the list; it is never
 * > merged field-by-field.
 *
 * A field-level merge is how "the badge says verified but the list says new"
 * happens: the local write set `status: 'verified'` and the snapshot carried the
 * other nine fields, and merging produced a document that never existed. This
 * module therefore treats a pending document as ATOMIC — the whole optimistic
 * value, or the previous one.
 *
 * ---------------------------------------------------------------------------
 * M-4: `changedIds` AND `pendingIds` ARE DISJOINT
 * ---------------------------------------------------------------------------
 * > `changedIds` never contains an id that is in `pendingIds` at the same time. A
 * > pending row is not "changed" — it is "being changed".
 *
 * This is what stops a row flashing "just updated" for the responder's own
 * action. The responder pressed the button; they do not need to be told the system
 * received it. The flash is for a change that arrived from SOMEONE ELSE.
 *
 * ---------------------------------------------------------------------------
 * THE SNAPSHOT IS THE SOURCE OF TRUTH FOR MEMBERSHIP
 * ---------------------------------------------------------------------------
 * The snapshot says exactly which documents match the query right now. So
 * `items` is derived from `snap.docs` and nothing else — the previous list is
 * consulted only to carry forward the pending flags. M-2 then falls out: a
 * document absent from `snap.docs` is absent from `items`, whatever the previous
 * list said.
 */

import type { DocumentData, QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore';

export type SnapshotRow = { readonly id: string } & Record<string, unknown>;

/**
 * The row contract `mergeSnapshot` needs: an `id`, plus whatever the UI renders.
 *
 * Constraining `T` to this is what lets M-2's carry-forward loop read `row.id`
 * without a cast. It is a real constraint rather than a convenience — the merge
 * has to key rows to identify them, and a row type without an id would make the
 * whole pending/flash mechanism unusable.
 */
export type HasId = { readonly id: string };

export type MergeResult<T> = {
  readonly items: readonly T[];
  /** Ids with an unacknowledged local write. M-4: disjoint from `changedIds`. */
  readonly pendingIds: ReadonlySet<string>;
  /** Ids the server has just confirmed, for the live flash. */
  readonly changedIds: ReadonlySet<string>;
};

export type MergeOptions<T> = {
  /**
   * Ids with a local write outstanding from BEFORE this snapshot.
   *
   * The function needs them to distinguish "the server just confirmed my write"
   * from "someone else changed this row". Without that distinction every local
   * action would produce a flash, and the flash would stop meaning anything.
   */
  readonly pendingIds: ReadonlySet<string>;
  /**
   * The mapper. Called once per document.
   *
   * A FUNCTION rather than reading the raw document, because the row shape is
   * Phase 8's and Firestore's `Timestamp` is not a renderable value. Doing the
   * conversion here keeps the mapping in one place and makes this function
   * testable with plain objects.
   */
  readonly map: (data: DocumentData, id: string) => T;
  /**
   * Rows to keep when a pending document's server copy has not landed.
   *
   * M-1's "keep the optimistic row": a pending document that is still in the
   * snapshot is rendered from the SNAPSHOT (Firestore already applied the local
   * write to its cache), and this lookup is only the fallback for a document that
   * vanished.
   */
  readonly previous?: readonly T[];
  /**
   * Ids to flash on the NEXT snapshot, even if the server change was a no-op from
   * Firestore's perspective.
   *
   * Not used by the merge itself — it is how a component records an id so the
   * flash survives one render. Exists as a parameter because the alternative is a
   * second `mergeSnapshot` call, and a second call re-derives `items` from an
   * identical snapshot and does nothing useful.
   */
  readonly forceChanged?: ReadonlySet<string>;
};

/**
 * Merge one `onSnapshot` into the current list.
 *
 * **Total.** Every input yields a result; nothing throws. A merge that threw would
 * leave the queue showing the previous payload with no explanation, which is the
 * failure `docs/11 §13` describes as "the data silently stops updating".
 */
export function mergeSnapshot<T extends HasId>(
  snapshot: Pick<QuerySnapshot<DocumentData>, 'docs' | 'docChanges' | 'size'>,
  options: MergeOptions<T>,
): MergeResult<T> {
  const nextPending = new Set<string>();
  const changed = new Set<string>();

  /** Document ids in the snapshot, for M-2. */
  const inWindow = new Set<string>();

  for (const change of snapshot.docChanges()) {
    const id = change.doc.id;
    if (change.type === 'removed') continue; // membership handled by `inWindow`

    // M-1 / `docs/11 §3.4`: read the flag from the DOCUMENT's metadata, not from
    // the previous list. Firestore is the only thing that knows whether this write
    // has been acknowledged.
    if (change.doc.metadata.hasPendingWrites) {
      nextPending.add(id);
      // M-4: explicitly NOT added to `changed`.
      continue;
    }

    // Server-confirmed. If this id was pending before this snapshot, the server has
    // just acknowledged our write — which the component needs to know about, so its
    // optimistic error handling can stand down.
    if (options.pendingIds.has(id)) {
      changed.add(id);
    } else {
      // Not ours. `docs/11 §3.4` treats a non-pending change as a real change.
      // Every document in a listener's first snapshot is a `added`, so the very
      // first callback would mark the whole list as changed — which is why the
      // caller passes `forceChanged` for its own ids and the consumer gates the
      // flash on `changedIds` minus what it already had.
      changed.add(id);
    }
  }

  /* --- M-2: `items` comes from the snapshot, and only the snapshot --------- */
  const items: T[] = [];
  for (const doc of snapshot.docs as readonly QueryDocumentSnapshot<DocumentData>[]) {
    inWindow.add(doc.id);
    items.push(options.map(doc.data(), doc.id));
  }

  /* --- carry forward anything pending that is not in this snapshot --------- */
  // A pending write whose document has not been delivered yet. Without this the
  // row would vanish for a frame and reappear, which reads as a flicker on the
  // exact row a responder is watching.
  if (options.previous !== undefined) {
    for (const row of options.previous) {
      if (inWindow.has(row.id)) continue;
      if (!nextPending.has(row.id)) continue;
      inWindow.add(row.id);
      items.push(row);
    }
  }

  for (const id of options.forceChanged ?? []) changed.add(id);

  return { items, pendingIds: nextPending, changedIds: changed };
}

/* ========================================================================== */
/* The flash window                                                            */
/* ========================================================================== */

/**
 * How long a changed row's flash lasts. `docs/11 §3.4` M-3 specifies 600 ms.
 *
 * Long enough to be noticed peripherally, short enough that scrolling a fast
 * queue does not leave a trail of flashing rows. **Discarded entirely under
 * `prefers-reduced-motion`** — M-3 says the consumer renders a static left rule
 * instead, so the information survives without the animation.
 */
export const FLASH_DURATION_MS = 600;

/**
 * Drop `changedIds` when the user asked for reduced motion. M-3.
 *
 * A function rather than a check inside the merge, so the merge stays a pure
 * function of the snapshot and the preference is applied at the point of
 * rendering. A merge that silently emptied `changedIds` would make the reduced-
 * motion path untestable by inspection.
 */
export function flashIdsFor(
  changedIds: ReadonlySet<string>,
  prefersReducedMotion: boolean,
): ReadonlySet<string> {
  return prefersReducedMotion ? new Set<string>() : changedIds;
}

/* ========================================================================== */
/* Single-document merge                                                       */
/* ========================================================================== */

/**
 * The L2a / L7 / L10 shape: one document, and the question is whether it changed.
 *
 * Distinct from `mergeSnapshot` because a single-document listener's first
 * callback is `added`, and marking it "changed" would flash a row the user just
 * navigated to. The rule is simply: flash only after the first delivery, and only
 * when a field the UI renders differs.
 */
export function singleDocumentChanged<T extends Record<string, unknown>>(
  previous: T | null,
  next: T,
  compare: (a: T, b: T) => boolean = shallowEqual,
): boolean {
  if (previous === null) return false;
  return !compare(previous, next);
}

/**
 * Field-by-field equality for the shallow documents this app stores.
 *
 * Shallow is correct here and worth saying why: every value in a Firestore
 * document is a primitive, a `Timestamp`, a `GeoPoint`, or a plain array/object.
 * A `Timestamp` is a class instance, so `===` on two timestamps for the same
 * instant is FALSE — which would make every snapshot look changed. Comparing
 * their ISO strings is the fix, and it is the only place in this module that knows
 * about that.
 */
export function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (isSameTimestamp(left, right)) continue;
    return false;
  }
  return true;
}

/** Two `Timestamp`s for the same instant, compared by value not identity. */
function isSameTimestamp(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftMillis = (left as { toMillis?: unknown }).toMillis;
  const rightMillis = (right as { toMillis?: unknown }).toMillis;
  if (typeof leftMillis !== 'function' || typeof rightMillis !== 'function') return false;
  try {
    return leftMillis.call(left) === rightMillis.call(right);
  } catch {
    return false;
  }
}
