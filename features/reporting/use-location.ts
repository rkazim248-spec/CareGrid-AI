'use client';

/**
 * ============================================================================
 * CareGrid AI — the location state machine
 * ============================================================================
 *
 * `docs/12 §12`. The one place that knows how a citizen's location is obtained,
 * confirmed, or abandoned.
 *
 * ---------------------------------------------------------------------------
 * THE THREE OPTIONS, EXACTLY (docs/12 §12.1)
 * ---------------------------------------------------------------------------
 * brief §33 names the same three, and `docs/12 §12.1` fixes them:
 *
 * 1. **Use my current location** — `gps`, with the accuracy the device reported
 * 2. **Choose on the map** — `manual_pin`, with the zoom-derived radius
 * 3. **Type an address** — `address_text`, geocoded server-side
 *
 * Plus a fourth state the brief also requires: **continue without location**,
 * which produces `source: 'none'` and a null `geo`.
 *
 * ---------------------------------------------------------------------------
 * WHY A MACHINE AND NOT FOUR INDEPENDENT BUTTONS
 * ---------------------------------------------------------------------------
 * `docs/12 §12.2` specifies a state machine, and the reason is that these options
 * are not independent: a citizen who denies the device must be offered the map, a
 * citizen who drops a pin must be able to go back to the device, and abandoning
 * location must be reachable from every state without losing the text they have
 * already written.
 *
 * Four independent booleans cannot represent that. `source` is the single
 * discriminator, and it is what `docs/12 §2.1` requires on every incident anyway —
 * so the UI state and the persisted state are the same value, and there is no
 * mapping step where the two can disagree.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO: IT NEVER INVENTS A COORDINATE
 * ---------------------------------------------------------------------------
 * brief §33: "Do not silently invent coordinates." Every path here either produces a
 * real point or produces `none`. In particular, choosing "continue without location"
 * does NOT fall back to a map centre, a district centroid, or a last-known position —
 * those would be a lie about where an emergency is, and `docs/12 §13.1`'s principle
 * ("a rejected report is a person with no help") applies to location as much as to
 * the report.
 */

import * as React from 'react';

import type { AccuracyGrade, LocationSource } from '@/types';
import { isValidLatLng, type LatLng } from '@/lib/geo/distance';
import {
  GEOLOCATION_COPY,
  geolocationCopy,
  manualPinAccuracy,
  useGeolocation,
  type GeolocationState,
  type GeoFix,
} from '@/features/reporting/use-geolocation';
import { needsApproximateWarning } from '@/lib/geo/accuracy';

/* ========================================================================== */
/* The states                                                                  */
/* ========================================================================== */

/**
 * `docs/12 §12.2`'s machine, named.
 *
 * `idle` and `none` are different: `idle` means the citizen has not chosen yet and
 * the prompt is still available, while `none` is a DECISION — "I am filing this
 * without location". Collapsing them would make it impossible to tell a citizen who
 * declined from one who has not got to the question yet, and the second group should
 * still be offered the device option.
 */
export type LocationChoice =
  /** Nothing chosen yet. */
  | 'idle'
  /** A device fix is in hand. */
  | 'gps'
  /** A pin was dropped on the map. */
  | 'manual_pin'
  /** An address was typed and geocoded. */
  | 'address_text'
  /** The citizen chose to continue without location. `geo == null`. */
  | 'none';

/** The location as the form holds it. Mirrors `docs/12 §2.3`'s `geo`. */
export type ResolvedLocation = {
  readonly source: LocationSource;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly accuracyM: number | null;
  /** Always present once resolved, even for `none`. GEO-1. */
  readonly accuracyGrade: AccuracyGrade;
  /** The typed address, ONLY when the citizen typed it. FR-035. */
  readonly locationText: string | null;
  /** A coarse label from the server. Never a street address. */
  readonly placeName: string | null;
};

export type UseLocation = {
  readonly choice: LocationChoice;
  readonly location: ResolvedLocation;
  /** The device request's own state, for the button's busy state. */
  readonly deviceState: GeolocationState;
  readonly isRequesting: boolean;
  readonly error: string | null;
  /** `docs/12 §3.4`'s explainer, shown BEFORE the prompt. */
  readonly explainer: string;
  readonly requestDevice: () => void;
  /** Confirm a point the citizen chose on the map. `zoom` sets the declared radius. */
  readonly confirmManualPin: (point: LatLng, zoom: number) => void;
  /** A typed address. Geocoded server-side, so this only records the TEXT. */
  readonly setTypedAddress: (text: string) => void;
  /** "Continue without location". The only path to `source: 'none'`. */
  readonly chooseNone: () => void;
  /** Back to `idle` without discarding the report. */
  readonly reset: () => void;
  /** `true` once something has been chosen, so the form can enable submit. */
  readonly isChosen: boolean;
  /** `true` when the UI must show the "Location is approximate" warning. */
  readonly needsApproximateWarning: boolean;
};

/** `docs/12 §2.1`'s `none`: a null `geo` with a graded accuracy and a source. */
const NO_LOCATION: ResolvedLocation = {
  source: 'none',
  lat: null,
  lng: null,
  accuracyM: null,
  accuracyGrade: 'unknown',
  locationText: null,
  placeName: null,
};

/* ========================================================================== */

export function useLocation(): UseLocation {
  const [choice, setChoice] = React.useState<LocationChoice>('idle');
  const [manual, setManual] = React.useState<{ point: LatLng; accuracyM: number } | null>(null);
  const [typedAddress, setTypedAddress] = React.useState<string | null>(null);

  const device = useGeolocation();

  // --- a device fix promotes the choice, ONCE ----------------------------
  // An effect rather than a `setState` in the device hook's callback, so the
  // promotion happens in ONE place. The `confirmed` guard is what stops a
  // re-render from re-promoting after the citizen has moved on to the map: without
  // it, a late-arriving fix would silently overwrite a pin the citizen deliberately
  // placed somewhere else.
  const [devicePromoted, setDevicePromoted] = React.useState(false);
  React.useEffect(() => {
    if (device.fix === null) return;
    if (choice !== 'idle' || devicePromoted) return;
    setDevicePromoted(true);
    setChoice('gps');
    // Intentionally NOT clearing `manual`: a citizen who drops a pin and then hits
    // "use my location" expects the pin to still be there if they change their mind.
  }, [device.fix, choice, devicePromoted]);

  /* --- the resolution --------------------------------------------------- */

  const location = React.useMemo<ResolvedLocation>(() => {
    if (choice === 'gps' && device.fix !== null) {
      const fix: GeoFix = device.fix;
      return {
        source: 'gps',
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        accuracyGrade: fix.accuracyGrade,
        // A GPS fix is not a typed address. FR-035: `locationText` is set only when
        // the reporter supplied it as text.
        locationText: null,
        placeName: null,
      };
    }
    if (choice === 'manual_pin' && manual !== null) {
      return {
        source: 'manual_pin',
        lat: manual.point.lat,
        lng: manual.point.lng,
        accuracyM: manual.accuracyM,
        // The declared radius is graded, not assumed good. A pin dropped at zoom 3
        // grades `unknown`, which is the honest answer and renders the wide ring.
        accuracyGrade: gradeForManualPin(manual.accuracyM),
        locationText: null,
        placeName: null,
      };
    }
    if (choice === 'address_text' && typedAddress !== null && typedAddress.length > 0) {
      // **No coordinates yet.** `docs/12 §5`: geocoding is server-side only (FR-035),
      // so the client holds the TEXT and the incident is created with a
      // `address_text` source whose coordinates come from the server's geocode. The
      // UI must therefore show "locating…" rather than a pin at an invented point.
      return {
        source: 'address_text',
        lat: null,
        lng: null,
        // The geocoder's granularity, min 200 m. docs/12 §2.1.
        accuracyM: 200,
        accuracyGrade: 'low',
        locationText: typedAddress,
        placeName: null,
      };
    }
    if (choice === 'none') return NO_LOCATION;
    // `idle`: nothing chosen. `accuracyGrade` is still present — GEO-1 requires it
    // on every incident — but the point is null, which is what makes this
    // distinguishable from a real fix at (0, 0).
    return { ...NO_LOCATION };
  }, [choice, device.fix, manual, typedAddress]);

  /* --- the actions ------------------------------------------------------ */

  const requestDevice = React.useCallback(() => {
    device.request();
  }, [device]);

  const confirmManualPin = React.useCallback((point: LatLng, zoom: number) => {
    // Validated here as well as at the API boundary, because a map click on a
    // misbehaving map can produce a non-finite coordinate and a form that submits
    // `NaN` is worse than one that refuses the pin.
    if (!isValidLatLng(point)) return;
    setManual({ point, accuracyM: manualPinAccuracy(zoom) });
    setTypedAddress(null);
    setChoice('manual_pin');
  }, []);

  const setTypedAddressHandler = React.useCallback((text: string) => {
    const trimmed = text.trim();
    setTypedAddress(trimmed.length === 0 ? null : trimmed);
    setManual(null);
    setChoice(trimmed.length === 0 ? 'idle' : 'address_text');
  }, []);

  const chooseNone = React.useCallback(() => {
    // brief §33's "Continue without location". Deliberately clears the other
    // options: leaving a stale pin behind while `source` says `none` would produce
    // an incident that claims no location and carries coordinates.
    setManual(null);
    setTypedAddress(null);
    setChoice('none');
  }, []);

  const reset = React.useCallback(() => {
    setManual(null);
    setTypedAddress(null);
    setDevicePromoted(false);
    device.reset();
    setChoice('idle');
  }, [device]);

  /* --- derived ---------------------------------------------------------- */

  const isRequesting = device.state === 'requesting';

  /**
   * The error, from whichever sub-machine is unhappy.
   *
   * Only the device sub-machine produces errors — the map and the typed address have
   * no failure state of their own (a bad pin is refused at `confirmManualPin`, and a
   * geocode happens server-side). So there is genuinely nothing else to fall back to,
   * and a `??` chain that ended in `null` on both sides would be decoration.
   */
  const error = device.error;

  return {
    choice,
    location,
    deviceState: device.state,
    isRequesting,
    error,
    explainer: GEOLOCATION_COPY.explainer,
    requestDevice,
    confirmManualPin,
    setTypedAddress: setTypedAddressHandler,
    chooseNone,
    reset,
    isChosen: choice !== 'idle',
    // `docs/12 §2.2` requires the warning for `low` and `unknown` grades, and a
    // shared predicate so the form, the queue row and the map panel agree.
    needsApproximateWarning:
      choice !== 'none' && needsApproximateWarning(location.accuracyGrade),
  };
}

/**
 * The grade for a declared manual-pin radius.
 *
 * **Graded from the DECLARED radius, not treated as good.** `docs/12 §2.1`: a
 * manual pin's `accuracyM` is "the map-declared radius", and §4.3's honesty rule
 * requires the ring to show it. A pin dropped while looking at a whole city grades
 * `unknown` and renders the wide dashed ring, which is the correct and slightly
 * humbling outcome.
 */
function gradeForManualPin(accuracyM: number): AccuracyGrade {
  if (accuracyM <= 50) return 'high';
  if (accuracyM <= 200) return 'medium';
  if (accuracyM <= 1000) return 'low';
  return 'unknown';
}

/**
 * The three fallback options, and their copy. `docs/12 §12.1`, brief §33.
 *
 * Exported so the `LocationPanel` renders exactly these and cannot invent a fourth.
 */
export const LOCATION_FALLBACK_OPTIONS = [
  {
    key: 'manual_pin' as const,
    label: 'Choose a point on the map',
    description: 'Move the map and drop a pin where the emergency is.',
  },
  {
    key: 'address_text' as const,
    label: 'Type an address',
    description: 'We will look it up. A map label, not an exact position.',
  },
  {
    key: 'none' as const,
    label: 'Continue without location',
    description: 'Your report will be filed with no location. You can add one later.',
  },
] as const;

/** The headline `docs/12 §12.1` requires above the options. */
export const LOCATION_UNAVAILABLE_HEADING = "We couldn't access your current location.";

/** Re-exported so the panel imports one module. */
export { geolocationCopy };
