/**
 * ============================================================================
 * CareGrid AI — the live dispatch row and the alert incident
 * ============================================================================
 *
 * **PURE.** No Firestore, no React — the same discipline as
 * `features/incidents/live-incident-row.ts`, for the same reason: a mapper that
 * can be unit-tested without an emulator is a mapper that gets tested.
 *
 * ---------------------------------------------------------------------------
 * WHAT A DISPATCH DOCUMENT DOES AND DOES NOT CONTAIN
 * ---------------------------------------------------------------------------
 * `services/dispatch/assign.ts` writes exactly: `dispatchId`, `incidentId`,
 * `responderUid`, `dispatchedBy`, `mode`, `status`, `distanceM`, `etaSec` (always
 * null — brief §30), `capabilityMatch`, `note`, `responseSec`, `dispatchedAt`,
 * `acceptedAt`, `withdrawnAt`, `withdrawnReason`, `completedAt`, `expiresAt`.
 *
 * It does NOT contain `incidentReference`, the responder's display name, or any
 * incident detail. The ledger columns that need those are therefore the
 * dispatcher's (mock-backed) view; the responder's own view renders what the
 * document actually has and links to the incident for the rest. Inventing a
 * reference or a name client-side would be a fabricated fact about an emergency.
 *
 * The alert's incident detail comes from a separate single-document listener
 * (`incidentQuery`, docs/11 L2a) — a responder may read their own incident
 * because `assign.ts` denormalised `assigneeUid` onto it (firestore.rules).
 */

import {
  DISPATCH_STATUSES,
  INCIDENT_CATEGORIES,
  URGENCIES,
  type DispatchMode,
  type DispatchStatus,
  type IncidentCategory,
  type Urgency,
} from '@/types';

/* ========================================================================== */
/* The timestamp reader                                                        */
/* ========================================================================== */

/**
 * A Firestore `Timestamp` (or a `Date`, or an ISO string) → an ISO string, or
 * `null`. Duck-typed rather than `instanceof` because the modular SDK's and the
 * Admin SDK's `Timestamp` are different classes. Returns `null` for anything
 * unrecognised — `new Date(x)` on a non-date produces `Invalid Date`, and an
 * `Invalid Date` reaching a formatter renders "NaN".
 */
function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') return value;
  return null;
}

function readString(data: Record<string, unknown>, field: string, fallback = ''): string {
  const raw = data[field];
  return typeof raw === 'string' ? raw : fallback;
}

function readNullableString(data: Record<string, unknown>, field: string): string | null {
  const raw = data[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readNumber(data: Record<string, unknown>, field: string): number | null {
  const raw = data[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function readBoolean(data: Record<string, unknown>, field: string): boolean {
  return data[field] === true;
}

/* ========================================================================== */
/* The dispatch row                                                            */
/* ========================================================================== */

export type LiveDispatchRow = {
  /** The document id — the `dispatchId` the accept/decline API addresses. */
  readonly id: string;
  readonly incidentId: string;
  readonly status: DispatchStatus;
  readonly mode: DispatchMode | null;
  /** `null` when either side has no coordinates. Never a fabricated distance. */
  readonly distanceM: number | null;
  /**
   * Always `null` by design (brief §30): no travel time is computed or claimed
   * anywhere in this build. The field is read only so a document that somehow
   * carries one cannot flow into the UI unchecked.
   */
  readonly etaSec: null;
  readonly capabilityMatch: boolean;
  readonly note: string | null;
  readonly dispatchedAt: string | null;
  readonly acceptedAt: string | null;
  readonly expiresAt: string | null;
  readonly responseSec: number | null;
};

const DISPATCH_STATUS_SET = new Set<DispatchStatus>(DISPATCH_STATUSES);
const DISPATCH_MODES: ReadonlySet<DispatchMode> = new Set<DispatchMode>(['auto_suggest', 'manual', 'self_claimed']);

/**
 * One dispatch document → one row. **Total**: every input yields a row; a mapper
 * that threw would take the responder's assignment list down on one malformed
 * document.
 */
export function toLiveDispatchRow(data: Record<string, unknown>, id: string): LiveDispatchRow {
  const rawStatus = data.status;
  const rawMode = data.mode;
  return {
    id,
    incidentId: readString(data, 'incidentId'),
    status:
      typeof rawStatus === 'string' && DISPATCH_STATUS_SET.has(rawStatus as DispatchStatus)
        ? (rawStatus as DispatchStatus)
        : 'active',
    mode:
      typeof rawMode === 'string' && DISPATCH_MODES.has(rawMode as DispatchMode)
        ? (rawMode as DispatchMode)
        : null,
    distanceM: readNumber(data, 'distanceM'),
    etaSec: null,
    capabilityMatch: readBoolean(data, 'capabilityMatch'),
    note: readNullableString(data, 'note'),
    dispatchedAt: toIso(data.dispatchedAt),
    acceptedAt: toIso(data.acceptedAt),
    expiresAt: toIso(data.expiresAt),
    responseSec: readNumber(data, 'responseSec'),
  };
}

/* ========================================================================== */
/* The alert incident                                                          */
/* ========================================================================== */

export type AlertIncident = {
  readonly id: string;
  /** Human code, e.g. `INC-204`. `docs/07 §1.1`. */
  readonly reference: string;
  readonly category: IncidentCategory;
  readonly urgency: Urgency;
  /** `true` when `urgency` was absent and defaulted. Never rendered silently. */
  readonly urgencyIsDefaulted: boolean;
  /** `docs/12 §2`'s human-readable place. Never raw coordinates in the alert. */
  readonly placeName: string | null;
  readonly resources: readonly { readonly resourceId: string; readonly quantity: number }[];
  /** When the incident was reported — the alert's "time reported". */
  readonly createdAt: string | null;
  readonly summary: string;
};

const CATEGORY_SET = new Set<IncidentCategory>(INCIDENT_CATEGORIES);
const URGENCY_SET = new Set<Urgency>(URGENCIES);

/**
 * One incident document → the alert's detail. Total, like the row mapper: a
 * malformed incident costs detail, not the alert itself.
 */
export function toAlertIncident(data: Record<string, unknown>, id: string): AlertIncident {
  const rawCategory = data.category;
  const rawUrgency = data.urgency;
  const rawResources = data.requiredResources;

  const resources = Array.isArray(rawResources)
    ? rawResources
        .map((item): { resourceId: string; quantity: number } | null => {
          if (typeof item !== 'object' || item === null) return null;
          const source = item as Record<string, unknown>;
          const resourceId = source.resourceId;
          const quantity = source.quantity;
          if (typeof resourceId !== 'string' || resourceId.length === 0) return null;
          return {
            resourceId,
            quantity: typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1,
          };
        })
        .filter((item): item is { resourceId: string; quantity: number } => item !== null)
    : [];

  return {
    id,
    reference: readString(data, 'reference', id),
    category:
      typeof rawCategory === 'string' && CATEGORY_SET.has(rawCategory as IncidentCategory)
        ? (rawCategory as IncidentCategory)
        : 'other',
    urgency:
      typeof rawUrgency === 'string' && URGENCY_SET.has(rawUrgency as Urgency)
        ? (rawUrgency as Urgency)
        : 'medium',
    urgencyIsDefaulted: !(
      typeof rawUrgency === 'string' && URGENCY_SET.has(rawUrgency as Urgency)
    ),
    placeName: readNullableString(data, 'placeName'),
    resources,
    createdAt: toIso(data.createdAt),
    summary: readString(data, 'summary'),
  };
}
