/**
 * CareGrid AI — domain types for the Phase 1 UI shell.
 *
 * These mirror the API response shapes in docs/08_API_SPECIFICATION.md and the
 * Firestore documents in docs/07_DATABASE_SCHEMA.md. Phase 1 renders them from
 * `lib/mock-data/**`; later phases replace only the *source*, never the type.
 *
 * Anything a role may not see is optional here, not silently present-and-empty.
 * Data minimisation must be visible in the shape (docs/04 §1.2 P9).
 */

import type {
  AccountStatus,
  AccuracyGrade,
  ActorRole,
  AuditAction,
  DispatchMode,
  DispatchStatus,
  DuplicateStatus,
  HistoryEventType,
  IncidentCategory,
  IncidentStatus,
  LocationSource,
  NotificationSeverity,
  NotificationType,
  ReportChannel,
  ResolutionCode,
  ResponderStatus,
  SafetyFlag,
  SlaState,
  TriageSource,
  Urgency,
  UrgencySource,
  UserRole,
  VerificationSource,
  VerificationStatus,
} from '@/types/enums';

/* -------------------------------------------------------------------------- */
/* User                                                                       */
/* -------------------------------------------------------------------------- */

export type User = {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  photoURL: string | null;
  role: UserRole;
  status: AccountStatus;
  provider: 'password' | 'google';
  createdAt: string;
  lastLoginAt: string;
};

export type Profile = {
  uid: string;
  displayName: string;
  timezone: string;
  locale: string;
  notifPrefs: {
    inApp: boolean;
    /** Never enabled in v1 — no provider is configured (FR-105). */
    sms: boolean;
    /** Never enabled in v1 — no provider is configured (FR-106). */
    whatsapp: boolean;
    email: boolean;
  };
};

export type NotificationPrefs = Profile['notifPrefs'];

/* -------------------------------------------------------------------------- */
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

export type GeoPoint = {
  lat: number;
  lng: number;
};

export type IncidentLocation = GeoPoint & {
  accuracyM: number;
  accuracyGrade: AccuracyGrade;
  source: LocationSource;
  /**
   * Reverse-geocoded label. A LABEL, not evidence — it is displayed beside the
   * coordinates, never in place of them, and never used for distance maths
   * (docs/12_MAP_LOCATION_SYSTEM.md §7).
   */
  placeName: string | null;
};

/* -------------------------------------------------------------------------- */
/* AI triage — docs/09 §5                                                    */
/* -------------------------------------------------------------------------- */

export type ResourceRequest = {
  resourceId: string;
  quantity: number;
  confidence: number;
  source: 'ai' | 'reporter' | 'dispatcher';
};

export type AiAnalysis = {
  runId: string;
  model: string;
  promptVersion: string;
  confidence: number;
  outcome: 'success' | 'validation_failed' | 'timeout' | 'error' | 'blocked';
  /** FR-029 — when true the incident still exists and a person must review it. */
  fallbackUsed: boolean;
  latencyMs: number;
  safetyFlags: SafetyFlag[];
  /** Server-provided plain-language explanation. Never generated client-side. */
  explanation: string;
};

export type ConfidenceBand = 'high' | 'medium' | 'low';

/* -------------------------------------------------------------------------- */
/* Incident                                                                   */
/* -------------------------------------------------------------------------- */

export type Incident = {
  incidentId: string;
  /** Human-facing code, e.g. `CG-7QK4M2`. Crockford base32. The anchor. */
  reference: string;
  status: IncidentStatus;
  category: IncidentCategory;
  urgency: Urgency;
  urgencySource: UrgencySource;
  triageSource: TriageSource;
  /** 0–1. The client derives the BAND from this; it never recomputes needsReview. */
  aiConfidence: number;
  /** Server-provided boolean. docs/09 §2.8. */
  aiNeedsReview: boolean;
  summary: string;
  /** Verbatim reporter text. Never re-written by the app. FR-003. */
  originalText: string;
  /** null when unknown — never defaulted to 0 or 1. FR-023. */
  peopleAffected: number | null;
  requiredResources: ResourceRequest[];
  safetyFlags: SafetyFlag[];
  location: IncidentLocation | null;
  reporterCount: number;
  linkedReportCount: number;
  evidenceCount: number;
  verification: VerificationSource;
  duplicateStatus: DuplicateStatus;
  duplicateOf: { incidentId: string; reference: string; score: number } | null;
  assignee: AssigneeSummary | null;
  /** Minutes. 5 / 15 / 60 / 240 by urgency. docs/07 §4.1 */
  slaTargetMin: number;
  slaState: SlaState;
  ageMin: number;
  distanceM: number | null;
  channel: ReportChannel;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  respondedAt: string | null;
  arrivedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  /** Soft delete. FR-123. */
  deletedAt: string | null;
  deletedBy: string | null;
  deleteReason: string | null;
  resolutionCode: ResolutionCode | null;
  resolutionNote: string | null;
};

export type AssigneeSummary = {
  uid: string;
  displayName: string;
  status: ResponderStatus;
};

/** What a citizen sees on /track. Deliberately smaller. */
export type TrackedIncident = Pick<
  Incident,
  | 'incidentId'
  | 'reference'
  | 'status'
  | 'category'
  | 'urgency'
  | 'summary'
  | 'slaTargetMin'
  | 'slaState'
  | 'location'
  | 'reporterCount'
  | 'evidenceCount'
  | 'createdAt'
  | 'updatedAt'
>;

export type DuplicateBreakdown = {
  distanceM: number;
  timeDeltaMin: number;
  categoryMatch: boolean;
  categoryGroupMatch: boolean;
  textSimilarity: number;
  matchedKeywords: string[];
  decision: DuplicateStatus;
  reasons: string[];
  algorithmVersion: string;
};

export type MediaRef = {
  mediaId: string;
  kind: 'image' | 'audio';
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  /** Demo Phase 1 uses a local placeholder, never a remote signed URL. */
  previewUrl: string | null;
  scanStatus: 'clean' | 'pending' | 'quarantined';
};

export type IncidentReport = {
  reportId: string;
  kind: 'original' | 'duplicate_link' | 'supplement' | 'correction';
  /** null for a responder — they never see reporter identity. FR-068. */
  reporter: { uid: string; displayName: string } | null;
  text: string | null;
  createdAt: string;
  similarityToPrimary: number | null;
  media: MediaRef[];
};

export type HistoryActor = {
  uid: string;
  displayName: string;
  role: ActorRole;
};

export type HistoryEvent = {
  eventId: string;
  eventType: HistoryEventType;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  actor: HistoryActor;
  reason: string | null;
  note: string | null;
  /** Rendered as visible text, never as a tooltip. docs/04 §5.25 */
  metadata: Record<string, string | number | boolean> | null;
  requestId: string;
  createdAt: string;
};

/* -------------------------------------------------------------------------- */
/* Responder                                                                  */
/* -------------------------------------------------------------------------- */

export type Responder = {
  uid: string;
  displayName: string;
  status: ResponderStatus;
  verification: VerificationStatus;
  capabilities: string[];
  serviceRadiusM: number;
  activeIncidentCount: number;
  maxConcurrentIncidents: number;
  lastLocationAt: string | null;
  lastLocationAccuracyGrade: AccuracyGrade | null;
  /** When the responder account was submitted for verification. */
  submittedAt: string;
  /** Derived: lastLocationAt older than STALE_LOCATION_MIN. */
  staleLocation: boolean;
  location: IncidentLocation | null;
  activeIncidentId: string | null;
  /** Dispatcher/admin only. Never rendered to a citizen. */
  phone: string | null;
  stats: ResponderStats;
  verificationNote: string | null;
  certifications: { name: string; expiresAt: string | null }[];
};

export type ResponderStats = {
  totalAssignments: number;
  acceptedAssignments: number;
  avgResponseSec: number | null;
};

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

export type Dispatch = {
  dispatchId: string;
  incidentId: string;
  incidentReference: string;
  responder: AssigneeSummary;
  dispatchedBy: string;
  mode: DispatchMode;
  status: DispatchStatus;
  distanceM: number | null;
  etaSec: number | null;
  capabilityMatch: boolean;
  note: string | null;
  responseSec: number | null;
  dispatchedAt: string;
  acceptedAt: string | null;
  expiresAt: string;
  completedAt: string | null;
};

export type DispatchCandidate = {
  responder: AssigneeSummary & { capabilities: string[]; activeIncidentCount: number };
  location: GeoPoint | null;
  distanceM: number;
  etaSec: number;
  capabilityMatch: boolean;
  missingResources: string[];
  /** US-022 AC2 — a stale responder is badged and sorted last. */
  staleLocation: boolean;
  rank: number;
};

/* -------------------------------------------------------------------------- */
/* Notification                                                               */
/* -------------------------------------------------------------------------- */

export type AppNotification = {
  notificationId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  incidentId: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
  actor: { uid: string; displayName: string } | null;
};

/* -------------------------------------------------------------------------- */
/* Resources — docs/07 §11.1                                                  */
/* -------------------------------------------------------------------------- */

export type ResourceItem = {
  resourceId: string;
  name: string;
  category:
    | 'medical'
    | 'fire'
    | 'rescue'
    | 'traffic'
    | 'utility'
    | 'shelter'
    | 'logistics'
    | 'medical_supplies';
  unit: 'vehicle' | 'person' | 'unit' | 'kit' | 'person_shift';
  active: boolean;
};

/* -------------------------------------------------------------------------- */
/* Analytics — docs/14 §2                                                     */
/* -------------------------------------------------------------------------- */

export type AnalyticsRange = {
  from: string;
  to: string;
  timezone: string;
  granularity: 'day' | 'week';
  /** 'rollup' for periods > 48h old, 'live' for a capped recent scan. */
  source: 'rollup' | 'live';
  /** Set when a capped scan could not cover the whole range. */
  advisory: string | null;
};

export type AnalyticsTotals = {
  total: number;
  active: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  resolved: number;
  cancelled: number;
  falseAlarm: number;
  meanTimeToVerifySec: number;
  meanTimeToDispatchSec: number;
  meanTimeToResolveSec: number;
  slaCompliancePct: number;
  duplicateRatePct: number;
  aiFallbackRatePct: number;
  meanAiConfidence: number;
  reportsPerIncident: number;
};

export type Analytics = {
  range: AnalyticsRange;
  totals: AnalyticsTotals;
  byCategory: { category: IncidentCategory; count: number; critical: number }[];
  trend: { bucket: string; created: number; resolved: number; critical: number }[];
  responseBuckets: { label: string; count: number }[];
  byUrgency: { urgency: Urgency; p50Sec: number; p90Sec: number }[];
  riskZones: RiskZone[];
  responders: {
    uid: string;
    displayName: string;
    assignments: number;
    accepted: number;
    avgResponseSec: number;
  }[];
};

export type RiskZone = {
  zoneId: string;
  centre: GeoPoint;
  radiusM: number;
  score: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  incidentCount: number;
  criticalCount: number;
  dominantCategory: IncidentCategory | null;
  computedAt: string;
};

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export type AuditEntry = {
  logId: string;
  actor: HistoryActor;
  action: AuditAction;
  entityType: 'incident' | 'user' | 'responder' | 'dispatch' | 'config' | 'auth' | 'notification';
  entityId: string;
  incidentRef: string | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  requestId: string;
  hasIpHash: boolean;
  createdAt: string;
};

/* -------------------------------------------------------------------------- */
/* Dashboard KPIs — docs/08 §7.3                                              */
/* -------------------------------------------------------------------------- */

export type DashboardTiles = {
  active: number;
  unassigned: number;
  critical: number;
  slaBreached: number;
  availableResponders: number;
  staleResponderLocations: number;
  potentialDuplicates: number;
  aiNeedsReview: number;
};

export type SystemHealth = {
  firestoreReads: number;
  listenersActive: number;
  listenersMax: number;
  aiSuccessPct: number;
  aiFallbackPct: number;
  maintenanceEnabled: boolean;
};

/* -------------------------------------------------------------------------- */
/* Paged list envelope — docs/08 §1.5                                         */
/* -------------------------------------------------------------------------- */

export type PageInfo = {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /** Only when the server provides it. Never invented. */
  total?: number;
};

export type Paged<T> = {
  items: T[];
  page: PageInfo;
};
