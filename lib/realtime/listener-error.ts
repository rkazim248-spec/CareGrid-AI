/**
 * ============================================================================
 * CareGrid AI — listener error mapping
 * ============================================================================
 *
 * `docs/11 §3.1` A-2, `docs/11 §11.3` SEC-1, `docs/16`. **PURE.**
 *
 * ---------------------------------------------------------------------------
 * AN UNHANDLED LISTENER ERROR IS AN UNHANDLED REJECTION
 * ---------------------------------------------------------------------------
 * `onSnapshot`'s error callback is not optional in practice. Omit it and a
 * permission failure surfaces as an unhandled promise rejection, the UI shows an
 * empty queue with no explanation, and the operator sees a dispatcher staring at a
 * blank screen during an incident.
 *
 * So this module is total and explicit: every Firestore error code becomes a
 * `code` the UI can branch on and a `message` a user can act on.
 *
 * ---------------------------------------------------------------------------
 * `permission-denied` IS A DEFECT, NOT A CONDITION
 * ---------------------------------------------------------------------------
 * `docs/11 §11.3` SEC-1: "A listener error of `permission-denied` is a **defect**,
 * not a condition. It means the query and the role disagree. Log it, surface
 * `FORBIDDEN`, and it must not be retried."
 *
 * The distinction is load-bearing. `unavailable` is transient and Firestore
 * retries by itself; retrying is correct. `permission-denied` is terminal — the
 * rules will never change mid-session — so a retry loop would open and close the
 * same channel forever, burning a slot in the registry each time. `retryable:
 * false` is what stops that, and the field is the mechanism rather than a comment.
 *
 * ---------------------------------------------------------------------------
 * NO `@/lib/server/*` IMPORT
 * ---------------------------------------------------------------------------
 * An earlier version of this file exported `toAppErrorFromListener`, importing
 * `AppError` from `@/lib/server/errors`. The project's own "No client-reachable
 * file imports a server module" check rejected it, and it was right to:
 * `lib/realtime/` is reachable from a component, and a server module reaching a
 * browser bundle will not build (NFR-013).
 *
 * The mapping therefore returns plain `{ code, message }`, which is all a component
 * needs. A ROUTE that wants an `AppError` builds one from those two fields — a
 * two-line conversion, against duplicating the error vocabulary in a second place.
 */

/** Whether the UI or the hook should try again. */
export type ListenerErrorKind =
  /** Transient. Firestore is already retrying internally. */
  | 'transient'
  /** The rules refused this query for this role. A defect. Never retried. */
  | 'permission'
  /** A malformed query — a missing composite index, a bad `orderBy`. */
  | 'query'
  /** Anything unrecognised. */
  | 'unknown';

export type MappedListenerError = {
  readonly kind: ListenerErrorKind;
  /** Matches the `AppError` codes in `lib/api/error-codes.ts`. */
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /** The raw Firestore code, for the console. Never shown to a user. */
  readonly firestoreCode: string | null;
};

/**
 * Map a listener error to something the UI can act on. **Never throws.**
 *
 * The user-facing copy is deliberately about what to DO, not about what went
 * wrong internally. "The database is temporarily unavailable. Nothing was changed"
 * tells a dispatcher to wait; "FirestoreError: 7 PERMISSION_DENIED" tells them
 * nothing and invites them to file a bug about a message.
 */
export function mapListenerError(error: unknown): MappedListenerError {
  const code = readFirestoreCode(error);

  switch (code) {
    case 'permission-denied':
      // SEC-1. A defect, surfaced as FORBIDDEN, never retried.
      return {
        kind: 'permission',
        code: 'FORBIDDEN',
        message: 'You do not have access to this view.',
        retryable: false,
        firestoreCode: code,
      };

    case 'unavailable':
    case 'deadline-exceeded':
    case 'resource-exhausted':
      return {
        kind: 'transient',
        code: 'DB_UNAVAILABLE',
        message: 'Live updates are temporarily unavailable. Reconnecting.',
        // `true` means the UI may offer a manual retry. Firestore's own retry is
        // automatic and separate; this flag is about a user-initiated action.
        retryable: true,
        firestoreCode: code,
      };

    case 'failed-precondition':
    case 'invalid-argument':
      // Almost always a missing composite index. `docs/11 §2.2` lists which index
      // each listener needs; this is the failure when one is not deployed.
      return {
        kind: 'query',
        code: 'DB_UNAVAILABLE',
        message: 'Live updates could not start. This view needs a database index that is not deployed.',
        // Retrying cannot help: the index either exists or it does not.
        retryable: false,
        firestoreCode: code,
      };

    case 'unauthenticated':
      return {
        kind: 'permission',
        code: 'AUTH_REQUIRED',
        message: 'Your session expired. Sign in again to see live updates.',
        retryable: false,
        firestoreCode: code,
      };

    case 'cancelled':
      // `onSnapshot` reports this on teardown. It is not an error condition and
      // must never render a banner — a `console.error` here is a false alarm on
      // every unmount.
      return {
        kind: 'unknown',
        code: 'DB_UNAVAILABLE',
        message: '',
        retryable: false,
        firestoreCode: code,
      };

    default:
      return {
        kind: 'unknown',
        code: 'DB_UNAVAILABLE',
        message: 'Live updates stopped. Reload to try again.',
        retryable: true,
        firestoreCode: code,
      };
  }
}

/**
 * Read a Firestore error's string `code`, defensively.
 *
 * `FirestoreError.code` is a string in the modular SDK, but a rejected
 * `runTransaction` can surface a `GrpcError` whose `code` is a NUMBER. Comparing
 * that against `'permission-denied'` would be false for every branch and fall to
 * `unknown` — a permission failure silently reported as retryable, which is the
 * one outcome SEC-1 exists to prevent.
 */
function readFirestoreCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Should this error be LOGGED?
 *
 * `cancelled` is excluded because `onSnapshot` reports it on every normal
 * teardown, and a `console.error` per unmount trains an operator to ignore the
 * console — which is exactly when a real `permission-denied` arrives.
 */
export function shouldLogListenerError(error: MappedListenerError): boolean {
  return error.firestoreCode !== 'cancelled';
}
