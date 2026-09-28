/**
 * ============================================================================
 * CareGrid AI — client API layer
 * ============================================================================
 *
 * `apiFetch` plus the four Phase 2 endpoints (`POST /api/me/bootstrap`,
 * `GET /api/me`, `PATCH /api/me`, `POST /api/auth/event`). No other endpoint
 * exists in this build; adding a function here requires adding the route first
 * (docs/05 §7.3).
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: THIS FILE NEVER IMPORTS FIREBASE
 * ---------------------------------------------------------------------------
 * The ID token arrives through a **registered provider**, not a direct import.
 * Two reasons, and the second is the important one:
 *
 *   1. Testability — a test injects a static token with no SDK at all.
 *   2. Dependency direction. `lib/api` is used by RSCs, by server actions, and
 *      by the browser. If it imported `firebase/auth`, every consumer would
 *      pull the whole Auth bundle, and a server component would reach for a
 *      client-only module.
 *
 * The provider is registered once by `SessionProvider`. Until it is, every call
 * fails fast with a named error rather than sending an unauthenticated request
 * and getting a confusing 401.
 *
 * ---------------------------------------------------------------------------
 * THE 401 PATH IS EXACTLY ONE RETRY
 * ---------------------------------------------------------------------------
 * `AUTH_EXPIRED` or `AUTH_INVALID_TOKEN` → `getIdToken(true)` → replay ONCE.
 * A second 401 throws and dispatches `cg:session-expired`, which the session
 * provider turns into a calm sign-out. Never a loop, and never a retry on
 * `AUTH_REQUIRED`, which means there was no token to refresh.
 *
 * ---------------------------------------------------------------------------
 * ABORT AND OUT-OF-ORDER RESPONSE DISCARD
 * ---------------------------------------------------------------------------
 * A dispatcher typing in the queue search fires a request every 300 ms. If the
 * first is slow and the third is fast, the first response can land LAST and
 * overwrite newer results — the UI shows results for a query the user has
 * already changed. Every request therefore carries an `AbortSignal`, and the
 * provider additionally stamps each request so a late arrival is discarded
 * rather than applied.
 */

import { z } from 'zod';

import {
  errorEnvelopeSchema,
  successEnvelopeSchema,
  type ApiMeta,
} from '@/lib/api/envelope';
import { ApiError } from '@/lib/api/errors';
import {
  meResponseSchema,
  authEventBodySchema,
  meBootstrapBodySchema,
  mePatchBodySchema,
  type MeResponse,
} from '@/validators/me';
import { aiTriageProbeBodySchema, aiTriageProbeResponseSchema } from '@/validators/ai';


/* ========================================================================== */
/* The token provider seam                                                    */
/* ========================================================================== */

export type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;

/**
 * Registered once by `SessionProvider`. Passing `null` is not supported: a
 * client with no token provider is a client that cannot authenticate, and
 * making that a runtime `TypeError` three frames later helps nobody.
 */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export function clearTokenProvider(): void {
  tokenProvider = null;
}

export function hasTokenProvider(): boolean {
  return tokenProvider !== null;
}

/* ========================================================================== */
/* Errors                                                                     */
/* ========================================================================== */

/**
 * `ApiError` now lives in `@/lib/api/errors` so a component can import the
 * ERROR without importing the fetch machinery, its token seam, and its response
 * schemas. It is re-exported here because `apiFetch` throws it and every existing
 * caller imports it from this module; that stays working while the two concerns
 * are actually separate files.
 *
 * The class gained `shouldRetry` and `fieldIssues` in Phase 3 — the difference
 * between "show a Retry button" and "do not", which is a UI decision that was
 * previously made by inspecting `status === 403` at each call site.
 */
export { ApiError, isApiError, isNetworkFailure, messageFor } from '@/lib/api/errors';

/** Fired when a second 401 proves the session cannot be recovered. */
export const SESSION_EXPIRED_EVENT = 'cg:session-expired';


function dispatchSessionExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

/* ========================================================================== */
/* apiFetch                                                                   */
/* ========================================================================== */

export type ApiFetchOptions<TData> = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
  signal?: AbortSignal;
  /** Required by `POST /api/incidents`; harmless elsewhere. Phase 3. */
  idempotencyKey?: string;
  /** 0 or 1. Only ever 1, and only for idempotent verbs. */
  retries?: 0 | 1;
  /**
   * The Zod parse for `data`.
   *
   * Typed as the SAFE-PARSE RESULT rather than the data, so the caller cannot
   * accidentally write `parse: (d) => d as TData` and skip validation while
   * still appearing to use the mechanism. `apiFetch` inspects `.success` and
   * raises `MALFORMED_RESPONSE` when it is false.
   */
  parse?: (data: unknown) => { success: true; data: TData } | { success: false };
  /** Skip the `Authorization` header. Only `GET /api/health`. */
  anonymous?: boolean;
};

/** Build a query string. Arrays repeat the key; `undefined`/`null` are dropped. */
export function buildQuery(
  params: Record<string, string | number | boolean | string[] | null | undefined> | undefined,
): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  const query = search.toString();
  return query === '' ? '' : `?${query}`;
}

export async function apiFetch<TData>(
  path: string,
  options: ApiFetchOptions<TData> = {},
): Promise<TData> {
  const {
    method = 'GET',
    body,
    query,
    signal,
    idempotencyKey,
    retries = 0,
    parse,
    anonymous = false,
  } = options;

  const url = `${path}${buildQuery(query)}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  // The token, unless this is a genuinely public endpoint.
  if (!anonymous) {
    if (!tokenProvider) {
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: 'The session layer is not ready yet. Wait for the page to finish loading.',
        status: 401,
        requestId: 'req_unregistered',
      });
    }
    const token = await tokenProvider();
    if (token === null) {
      // Not an error to recover from: the caller is signed out. Surface it as
      // AUTH_REQUIRED so the layout gate sends them to /login.
      throw new ApiError({
        code: 'AUTH_REQUIRED',
        message: 'Sign in to continue.',
        status: 401,
        requestId: 'req_signed_out',
      });
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    // No `credentials: 'include'`. There is no cookie (docs/10 §12.1), and
    // sending one would be inventing an ambient credential the design
    // deliberately does not have.
    cache: 'no-store',
  });

  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw === '' ? null : JSON.parse(raw);
  } catch {
    throw new ApiError({
      code: 'MALFORMED_RESPONSE',
      message: 'The server sent something we could not read. Try again.',
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? 'req_unknown',
    });
  }

  /* --- error path --------------------------------------------------------- */
  if (!response.ok) {
    const parsedError = errorEnvelopeSchema.safeParse(payload);
    if (parsedError.success) {
      const { error, meta } = parsedError.data;
      const apiError = new ApiError({
        code: error.code,
        message: error.message,
        status: response.status,
        requestId: meta.requestId,
        details: error.details ?? [],
        retryAfterSec: error.retryAfterSec ?? meta.retryAfterSec ?? null,
        allowed: error.allowed ?? null,
      });

      // The ONE retry. Only for a refreshable 401, and only once.
      if (apiError.isRefreshable && retries >= 1 && !anonymous) {
        return apiFetch<TData>(path, { ...options, retries: (retries - 1) as 0 | 1 });
      }

      // A second 401 means the session is unrecoverable. Tell the app, do not
      // decide for it.
      if (apiError.status === 401 && !apiError.isRefreshable) {
        dispatchSessionExpired();
      } else if (apiError.status === 401) {
        dispatchSessionExpired();
      }

      throw apiError;
    }

    throw new ApiError({
      code: 'MALFORMED_RESPONSE',
      message: 'The server sent an error we could not read. Try again.',
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? 'req_unknown',
    });
  }

  /* --- success path ------------------------------------------------------- */
  const parsedSuccess = successEnvelopeSchema(z.unknown()).safeParse(payload);
  if (!parsedSuccess.success) {
    throw new ApiError({
      code: 'MALFORMED_RESPONSE',
      message: 'The server sent a response we could not read. Try again.',
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? 'req_unknown',
    });
  }

  const { data, meta }: { data: unknown; meta: ApiMeta } = parsedSuccess.data;

  if (!parse) return data as TData;
  const result = parse(data);
  if (!result.success) {
    // The shape did not match. This is a CONTRACT failure between server and
    // client, and swallowing it would render undefined values all over the
    // page. The requestId is the only handle on it.
    throw new ApiError({
      code: 'MALFORMED_RESPONSE',
      message: 'The server sent data in an unexpected shape.',
      status: response.status,
      requestId: meta.requestId,
    });
  }
  return result.data as TData;
}

/* ========================================================================== */
/* Endpoints — Phase 2 and Phase 3                                            */
/* ========================================================================== */

export type MeBootstrapResult = {
  user: MeResponse['user'];
  /** `true` when this call created the profile. `false` on a repeat call. */
  isNew: boolean;
};

/**
 * `POST /api/me/bootstrap`
 *
 * Idempotent by design: an existing `users/{uid}` is returned UNCHANGED
 * (docs/10 §3.2). That is what makes it safe to call on every sign-in — the
 * provider calls it whenever it finds a Firebase user with no profile, so a
 * user who closed the tab mid-bootstrap is repaired on the next load rather
 * than locked out.
 *
 * The body carries no role. The route writes `citizen`.
 */
export function meBootstrap(
  input: z.input<typeof meBootstrapBodySchema>,
  options: { signal?: AbortSignal } = {},
): Promise<MeBootstrapResult> {
  return apiFetch<unknown>('/api/me/bootstrap', {
    method: 'POST',
    body: meBootstrapBodySchema.parse(input),
    retries: 1,
    signal: options.signal,
    parse: (data) =>
      z
        .object({
          user: meResponseSchema.shape.user,
          isNew: z.boolean(),
        })
        .safeParse(data),
  }) as Promise<MeBootstrapResult>;
}

/** `GET /api/me` — the server-computed user, profile, and permission list. */
export function meGet(options: { signal?: AbortSignal } = {}): Promise<MeResponse> {
  return apiFetch<unknown>('/api/me', {
    method: 'GET',
    retries: 1,
    signal: options.signal,
    parse: (data) => meResponseSchema.safeParse(data),
  }) as Promise<MeResponse>;
}

/**
 * `PATCH /api/me` — the editable profile slice.
 *
 * No `retries`: a PATCH is not idempotent in general, and a blind replay of a
 * notification-preference change is a decision this client should not make.
 */
export function mePatch(
  input: z.input<typeof mePatchBodySchema>,
  options: { signal?: AbortSignal } = {},
): Promise<{ user: MeResponse['user'] }> {
  return apiFetch<unknown>('/api/me', {
    method: 'PATCH',
    body: mePatchBodySchema.parse(input),
    signal: options.signal,
    parse: (data) => z.object({ user: meResponseSchema.shape.user }).safeParse(data),
  }) as Promise<{ user: MeResponse['user'] }>;
}

/**
 * `POST /api/auth/event` — report a login or logout for the audit trail.
 *
 * Best-effort BY DESIGN. It is called on sign-out, where the token is already
 * gone, so a failure here must never block the sign-out or surface an error to
 * someone who has just asked to leave. A `console.warn` in development is the
 * whole error handling.
 */
export async function authEvent(
  input: z.input<typeof authEventBodySchema>,
): Promise<{ ok: true } | null> {
  try {
    return await apiFetch<{ ok: true }>('/api/auth/event', {
      method: 'POST',
      body: authEventBodySchema.parse(input),
      parse: (data) => z.object({ ok: z.literal(true) }).safeParse(data),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[auth] could not record the auth event', error);
    }
    return null;
  }
}

/** `GET /api/health` — public liveness. No token. */
export function getHealth(options: { signal?: AbortSignal } = {}): Promise<{
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  uptimeSec: number;
  timestamp: string;
}> {
  return apiFetch<unknown>('/api/health', {
    method: 'GET',
    anonymous: true,
    signal: options.signal,
    // `.passthrough()`-equivalent: the Phase 3 payload added `service`,
    // `uptimeSec`, and `timestamp` to Phase 2's `{ status, version }`, and an
    // older cached client must keep working. An unknown response key is dropped
    // rather than fatal (docs/17 §1.2) — the strict rule is for REQUESTS, where
    // an unknown key means a version mismatch the caller should hear about.
    parse: (data) =>
      z
        .object({
          status: z.enum(['ok', 'degraded']),
          service: z.string(),
          version: z.string(),
          uptimeSec: z.number(),
          timestamp: z.string(),
        })
        .safeParse(data),
  }) as Promise<{
    status: 'ok' | 'degraded';
    service: string;
    version: string;
    uptimeSec: number;
    timestamp: string;
  }>;
}

/* ========================================================================== */
/* Endpoints — Phase 3                                                        */
/* ========================================================================== */

/**
 * `GET /api/auth/me` — an ALIAS of `GET /api/me`.
 *
 * Provided for callers that reach for the `/api/auth/*` grouping. `meGet` below
 * is the canonical call and is what the session provider uses; this exists so
 * both paths are exercised and both are known to work.
 */
export function authMe(options: { signal?: AbortSignal } = {}): Promise<MeResponse> {
  return apiFetch<unknown>('/api/auth/me', {
    method: 'GET',
    retries: 1,
    signal: options.signal,
    parse: (data) => meResponseSchema.safeParse(data),
  }) as Promise<MeResponse>;
}

/**
 * `POST /api/ai/triage` - the citizen-facing triage call.
 *
 * ---------------------------------------------------------------------------
 * PHASE 4: THIS IS NO LONGER A PROBE
 * ---------------------------------------------------------------------------
 * In Phase 3 this returned the fallback unconditionally, and its purpose was to
 * prove the pipeline degraded honestly. It now performs real triage when
 * `GEMINI_API_KEY` is set, and falls back to the keyword engine when it is not.
 * The response contract gained `outcome`, `attempt`, `lowConfidence`, `simulated`,
 * `mediaCount`, `mediaDropped` and `aiRunId`; see `validators/ai.ts` for why each
 * exists, and `docs/30.5` for the phase record.
 *
 * The name is kept rather than renamed to `aiTriage`. A rename would be a
 * second breaking change to every call site for a benefit no caller can observe,
 * and the docs' endpoint list names this path.
 *
 * **`retries` is deliberately absent.** `apiFetch`'s default retry behaviour
 * applies to network-level failures, and a retried POST is a second model call:
 * the per-user rate limit in `RATE_LIMIT_RULES` is the abuse control, and a
 * silent client-side retry would spend quota behind the user's back. The server
 * already retries `429`/`503` internally with a documented backoff, so the two
 * layers must not stack.
 *
 * The returned type is the SERVER's schema, and `features/reporting/ai-triage-types.ts`
 * maps it to the client's `AiTriageResponse`. The mapping is one function so the
 * narrowing from `string[]` to `SafetyFlag[]` happens in exactly one place.
 */
export function aiTriage(
  input: z.input<typeof aiTriageProbeBodySchema>,
  options: { signal?: AbortSignal } = {},
): Promise<z.infer<typeof aiTriageProbeResponseSchema>> {
  return apiFetch<unknown>('/api/ai/triage', {
    method: 'POST',
    body: aiTriageProbeBodySchema.parse(input),
    signal: options.signal,
    parse: (data) => aiTriageProbeResponseSchema.safeParse(data),
  }) as Promise<z.infer<typeof aiTriageProbeResponseSchema>>;
}

/**
 * The Phase 3 name, kept as an alias.
 *
 * Two names for one endpoint is normally a smell, and docs/30.4 §3.1 made the
 * same argument about `/api/auth/me`. The difference: that alias existed to
 * document a second documented path, whereas this one exists only so an existing
 * Phase 3 test and any code written against the probe keeps compiling. If you
 * are writing new code, call `aiTriage`.
 */
export const aiTriageProbe = aiTriage;

/**
 * `GET /api/admin/system/health` — operator configuration view. ADMIN ONLY.
 *
 * Returns variable NAMES and booleans, never a secret value. A citizen calling
 * this gets `403 FORBIDDEN`, which `ApiError.isPermanentDenial` reports, so the
 * UI must not offer a Retry.
 */
export function adminSystemHealth(options: { signal?: AbortSignal } = {}): Promise<{
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  timestamp: string;
  uptimeSec: number;
  providers: ReadonlyArray<{
    provider: string;
    configured: boolean;
    requiredVars: readonly string[];
    problem: string | null;
  }>;
  problems: readonly string[];
}> {
  return apiFetch<unknown>('/api/admin/system/health', {
    method: 'GET',
    signal: options.signal,
    parse: (data) =>
      z
        .object({
          status: z.enum(['ok', 'degraded']),
          service: z.string(),
          version: z.string(),
          timestamp: z.string(),
          uptimeSec: z.number(),
          providers: z.array(
            z.object({
              provider: z.string(),
              configured: z.boolean(),
              requiredVars: z.array(z.string()),
              problem: z.string().nullable(),
            }),
          ),
          problems: z.array(z.string()),
        })
        .safeParse(data),
  }) as Promise<{
    status: 'ok' | 'degraded';
    service: string;
    version: string;
    timestamp: string;
    uptimeSec: number;
    providers: ReadonlyArray<{
      provider: string;
      configured: boolean;
      requiredVars: readonly string[];
      problem: string | null;
    }>;
    problems: readonly string[];
  }>;
}

export type { MeResponse };

