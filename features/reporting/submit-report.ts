/**
 * `POST /api/incidents` — send the report.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT SENT
 * ---------------------------------------------------------------------------
 * There is one place in this file that builds a request body and it is the
 * `incidentCreateBodySchema.parse` inside `createIncident` in `lib/api/client.ts`.
 * Everything below only assembles values that will be validated there.
 *
 * Two things this deliberately does NOT send:
 *
 *  - **`triage`.** The citizen's draft-triage preview is a convenience, not an
 *    input. Sending it would let the create route trust a client-supplied category
 *    over its own server-side call. The authoritative triage happens inside
 *    `services/incidents/create.ts`, so a citizen who skips "Analyze" gets the same
 *    real AI-derived category as one who did not.
 *  - **`evidenceIds` / `audioNote`.** Both are server-owned. The body carries
 *    `media[]` — the staging paths the server itself minted — and the server
 *    re-validates ownership, re-sniffs the bytes and decides what becomes evidence.
 *    A client that asserted ids could put evidence on an incident that was never
 *    uploaded.
 *
 * ---------------------------------------------------------------------------
 * NO RETRY
 * ---------------------------------------------------------------------------
 * `apiFetch` defaults to 0 retries and this call keeps it. A replayed POST is a
 * second incident: two documents, one reference handed to the citizen, and a
 * dispatcher looking at the same emergency twice. On failure the draft is left
 * intact and the error is shown, so pressing send again is a deliberate act.
 *
 * ---------------------------------------------------------------------------
 * IN-FLIGHT UPLOADS BLOCK SUBMIT
 * ---------------------------------------------------------------------------
 * `collectAttachableMedia()` returns the still-uploading items so this can say
 * "your photo is still uploading" instead of submitting without it. Discarding a
 * photo the citizen believes they attached is the failure mode docs/15 §8.1 is
 * written against.
 */

import type { z } from 'zod';

import { createIncident, isApiError } from '@/lib/api/client';
// Both schemas are used only in `typeof` position here — the actual `.parse()` call
// lives in `createIncident` in `lib/api/client.ts`, so this module must not be the
// place that decides what a valid body is.
import type { incidentCreateBodySchema, incidentCreateResponseSchema } from '@/validators/incident';
import type { AccuracyGrade, LocationSource } from '@/types/enums';

import type { AttachableMedia } from './upload-manager';

/**
 * The submit lifecycle, as a single discriminated union.
 *
 * One union rather than three booleans, because the three ways a naive version
 * goes wrong are mutually contradictory: `isSending && !hasError`, a submit that
 * is "done" and "busy", a form that is neither because both flags were reset by
 * different code paths. A discriminated union makes every impossible state
 * unrepresentable, and makes the exhaustive `switch` in the form the compiler
 * checks for a missed state.
 *
 * `checking` → `sending` → `finishing` are one in-flight call, not three: the
 * single `POST /api/incidents` does the attach, the triage and the duplicate
 * check inline, so the finer phases are a UI affordance (what the button says)
 * rather than separate requests. They must never be driven by timers.
 */
export type SubmitPhase =
  | { readonly phase: 'idle' }
  /** Reading the upload store and confirming nothing is still uploading. */
  | { readonly phase: 'checking' }
  | { readonly phase: 'sending' }
  /** The request is in flight; the server is now working. */
  | { readonly phase: 'finishing' }
  | { readonly phase: 'succeeded' }
  | { readonly phase: 'failed'; readonly message: string; readonly recoverable: boolean };

/**
 * Build the request body from the form's current state.
 *
 * Separate from `submitReport` so it can be unit-tested without a network, and so
 * the "what would we send" question has an answer that is not "whatever
 * `handleSubmit` happens to produce this week".
 */
export function buildIncidentPayload(
  args: {
    readonly text: string;
    readonly language: string;
    /** Already in wire form, via `toSubmitLocation`. */
    readonly location: z.input<typeof incidentCreateBodySchema>['location'];
    readonly peopleAffected: number | null;
    readonly media: readonly AttachableMedia[];
  },
): z.input<typeof incidentCreateBodySchema> {
  return {
    text: args.text.trim(),
    language: args.language,
    location: args.location,
    peopleAffected: args.peopleAffected,
    media: args.media.map((item) => ({
      storagePath: item.storagePath,
      // `displayName` is sanitised again by `safeDownloadName` server-side; this
      // trim just keeps an all-whitespace name out of the wire format.
      displayName: item.displayName.trim(),
    })),
  };
}

/**
 * Convert the location machine's output into what `POST /api/incidents` accepts,
 * or `null` when there is no location to send.
 *
 * ---------------------------------------------------------------------------
 * THIS IS WHERE `source: 'none'` BECOMES `null`, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `use-location`'s `ResolvedLocation` models "the citizen chose to continue without
 * location" as a *resolved* state — `source: 'none'` with null coordinates. The
 * server has no such state: `incidentLocationSchema` refuses `source: 'none'`
 * outright ("send location: null instead") because an object whose source is `none`
 * and whose coordinates are null is a shape that can be got wrong later, by a
 * component that reads `geo.lat` without checking.
 *
 * So `null` is the wire form of "no location", and it is meaningful rather than a
 * fallback: it records "location unknown" and it hides the map pin.
 *
 * It is never `{ lat: 0, lng: 0 }`. That would put the incident in the Gulf of
 * Guinea, look like a real fix on the map, and be worse than admitting ignorance.
 *
 * ---------------------------------------------------------------------------
 * `address_text` IS THE ONE SOURCE THAT SENDS WITHOUT COORDINATES
 * ---------------------------------------------------------------------------
 * A citizen who typed "1600 Pennsylvania Ave" has text and no point, because
 * FR-035 puts geocoding server-side and nowhere else. Returning `null` for that
 * case would silently discard the one piece of location information they gave —
 * the exact bug this change exists to fix.
 *
 * So `address_text` is sent as `{ lat: null, lng: null, placeName: <typed text> }`,
 * and `services/maps/geocode.ts` resolves it server-side. The schema enforces that
 * this source must carry `placeName`, so an address-only location can never be an
 * object with nothing in it.
 *
 * ---------------------------------------------------------------------------
 * `accuracyM` MUST HAVE A NUMBER HERE
 * ---------------------------------------------------------------------------
 * `ResolvedLocation.accuracyM` is nullable; the wire schema is not. The two
 * nullable cases are resolved explicitly rather than defaulted:
 *
 *  - `source: 'none'` → returned as `null` above.
 *  - a real source with a null radius → fall back to `100_000` (100 km), the
 *    schema's ceiling, and let `accuracyGrade` carry the real story. `grade` is
 *    `'unknown'` in that case, and `accuracyGrade` is what the UI and the SLA
 *    logic read — so a guessed radius cannot masquerade as a precise fix.
 *
 * `placeName` prefers the server's coarse label and falls back to the citizen's
 * typed text, which `FR-035` explicitly permits. It is a label for display only and
 * is never used for distance maths.
 */
export function toSubmitLocation(
  resolved: {
    readonly source: LocationSource;
    readonly lat: number | null;
    readonly lng: number | null;
    readonly accuracyM: number | null;
    readonly accuracyGrade: AccuracyGrade;
    readonly placeName: string | null;
    /** Present only on `ResolvedLocation`, where it is the reporter's typed text. */
    readonly locationText?: string | null;
  } | null,
): z.input<typeof incidentCreateBodySchema>['location'] {
  if (resolved === null || resolved.source === 'none') return null;

  const placeName = resolved.placeName ?? resolved.locationText ?? null;
  const label = placeName !== null && placeName.trim().length > 0 ? placeName.trim() : null;

  // Typed address, no fix yet. The server geocodes; see the note above.
  if (resolved.lat === null || resolved.lng === null) {
    if (resolved.source !== 'address_text') return null;
    if (label === null) return null;
    return {
      lat: null,
      lng: null,
      // The geocoder's granularity is not known client-side, so this is the
      // docs/12 §2.1 floor for `address_text` and the server replaces it with the
      // provider's declared value when it succeeds.
      accuracyM: 200,
      accuracyGrade: 'low',
      source: 'address_text',
      placeName: label,
    };
  }

  return {
    lat: resolved.lat,
    lng: resolved.lng,
    accuracyM: resolved.accuracyM ?? 100_000,
    accuracyGrade: resolved.accuracyGrade,
    source: resolved.source,
    placeName: label,
  };
}

/**
 * Send the report and return the created incident's public reference.
 *
 * Throws on any failure rather than returning a union: `report-form.tsx` already
 * has an error surface, and a second error channel here would be one of them
 * silently ignored.
 */
export async function submitReport(
  args: {
    readonly text: string;
    readonly language: string;
    readonly location: z.input<typeof incidentCreateBodySchema>['location'];
    readonly peopleAffected: number | null;
    readonly media: readonly AttachableMedia[];
  },
): Promise<z.infer<typeof incidentCreateResponseSchema>> {
  return createIncident(buildIncidentPayload(args));
}

/**
 * Turn a thrown submit error into something a person can act on.
 *
 * The distinction that matters: **is the draft still safe?** Almost always yes —
 * `POST /api/incidents` is atomic, so a failed submit wrote nothing. Telling a
 * citizen their report was lost when it is sitting in the form would push them to
 * retype it, and telling them it is safe when it is not would lose it.
 *
 * `429` is the one case worth calling out, because it means the answer is "wait",
 * not "retry now" — a citizen hammering send after a rate limit is what the limit
 * is for.
 */
export function describeSubmitError(error: unknown): {
  readonly message: string;
  readonly recoverable: boolean;
} {
  if (isApiError(error)) {
    if (error.status === 429) {
      return {
        message: 'You have sent a few reports very quickly. Please wait a moment before sending another.',
        recoverable: true,
      };
    }
    if (error.status === 401) {
      return {
        message: 'Your session ended. Please sign in again — your report text is still here.',
        recoverable: false,
      };
    }
    if (error.status === 403) {
      return { message: error.message, recoverable: false };
    }
    if (error.status === 400) {
      // The server's message is already written for a person (it names the photo
      // cap, the text length, or the bad upload reference), so it is passed
      // through rather than replaced.
      return { message: error.message, recoverable: true };
    }
    if (error.status === 502 || error.status === 503) {
      return {
        message: error.message,
        recoverable: true,
      };
    }
    if (error.status === 0) {
      return {
        message: 'You appear to be offline. Your report text is safe — please try again when you have a connection.',
        recoverable: true,
      };
    }
  }
  return {
    message: 'Your report could not be sent. Your text is still here — please try again.',
    recoverable: true,
  };
}