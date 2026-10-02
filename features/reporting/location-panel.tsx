'use client';

import * as React from 'react';
import { Crosshair, MapPinOff, PencilLine, Pin } from 'lucide-react';

import { Button, Input, Separator } from '@/components/ui';
import { LocationBadge } from '@/components/domain';
import { REPORT_COPY } from '@/features/reporting/report-copy';
import { PinPickerMap } from '@/features/reporting/pin-picker-map';
import { useLocation } from '@/features/reporting/use-location';
import type { LocationMethod, ReportLocation } from '@/features/reporting/report-types';

/**
 * Location panel — docs/04 §13.2 (`useGeolocation` + `LocationFallback`).
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY IT WAS A LIE BEFORE
 * ---------------------------------------------------------------------------
 * This panel used to resolve a location in 700 ms from `MOCK_INCIDENTS` and label
 * the result "From the demonstration dataset." Nothing was measured, no permission
 * was asked for, and `ReportLocation` had no `lat`/`lng` to hold a fix — so even a
 * successful press produced a location that could not be submitted.
 *
 * `useLocation` is now the single owner of location state. It already wraps
 * `useGeolocation` internally (docs/12 §5), so this panel does NOT call
 * `useGeolocation` again: two instances would mean two independent permission
 * requests, and the second one would fail with a `denied` that the first one's
 * success had already disproved.
 *
 * ---------------------------------------------------------------------------
 * THE ADDRESS FIELD IS AN INPUT, NOT A BUTTON
 * ---------------------------------------------------------------------------
 * The old "Type an address" button set `source: 'address_text'` and immediately
 * reported success, because there was no field to type into — the button lied by
 * being clickable. There is now a real `TextInput`. FR-035 keeps geocoding
 * server-side, so the client holds TEXT and sends no coordinates; the server's
 * Mapbox geocode produces the point at submit time.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GPS BUTTON IS STILL A BUTTON AND NOT AN AUTO-PROMPT
 * ---------------------------------------------------------------------------
 * `useLocation` never calls `request()` on mount, and neither does any effect here.
 * docs/12 §3.5 forbids an auto-prompt: the browser permission dialog is a real
 * privacy moment, and spending it unasked — before the citizen has described an
 * emergency — is the behaviour that gets location APIs revoked.
 */
export function LocationPanel({
  location,
  method,
  onChange,
}: {
  location: ReportLocation;
  method: LocationMethod;
  onChange: (location: ReportLocation, method: LocationMethod) => void;
}) {
  const manual = useLocation();
  // The typed text lives here rather than in `useLocation`, so an in-progress edit
  // is not reset by a re-render of the machine's own state.
  const [address, setAddress] = React.useState('');
  // Whether the map is open. Separate from `choice`, because `choice` becomes
  // `manual_pin` only AFTER a point is confirmed — opening the picker must not
  // already claim the citizen chose a location.
  const [pickerOpen, setPickerOpen] = React.useState(false);

  // `useLocation` is the source of truth; mirror it into the draft shape so the
  // form has exactly one location to submit, and there is one path from "citizen
  // pressed a button" to the wire.
  React.useEffect(() => {
    const resolved = manual.location;
    if (resolved.source === 'none') {
      onChange(NO_LOCATION, manual.choice === 'idle' ? 'none' : 'skipped');
      return;
    }
    onChange(
      {
        source: resolved.source,
        accuracyM: resolved.accuracyM,
        accuracyGrade: resolved.accuracyGrade,
        placeName: resolved.placeName ?? resolved.locationText,
        lat: resolved.lat,
        lng: resolved.lng,
      },
      methodFor(resolved.source),
    );
  }, [manual.location, manual.choice, onChange]);

  const finding = manual.isRequesting;
  const showAddressField = manual.choice === 'address_text';

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[72ch] text-sm text-secondary">{REPORT_COPY.locationLead}</p>

      <Button
        type="button"
        variant="primary"
        size="lg"
        className="w-full sm:w-auto"
        loading={finding}
        onClick={manual.requestDevice}
      >
        {!finding ? <Crosshair aria-hidden="true" /> : null}
        {REPORT_COPY.useCurrentLocation}
      </Button>

      {/* The failure taxonomy, each with its own sentence from `useGeolocation`. */}
      {manual.error !== null ? (
        <p className="text-sm text-warning" role="status">
          {manual.error}
        </p>
      ) : null}

      {location.source === 'none' ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <MapPinOff className="size-4" aria-hidden="true" />
          No location added.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <LocationBadge
            accuracyGrade={location.accuracyGrade}
            accuracyM={location.accuracyM}
            source={location.source}
          />
          <p className="text-sm text-secondary">{describeLocation(location)}</p>
          {manual.needsApproximateWarning ? (
            <p className="text-xs text-muted">
              This location is approximate. A responder will confirm it before acting on it.
            </p>
          ) : null}
        </div>
      )}

      <Separator className="my-1" />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-primary">{REPORT_COPY.fallbackTitle}</p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant={manual.choice === 'manual_pin' ? 'primary' : 'outline'}
            size="lg"
            className="w-full sm:w-auto"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Pin aria-hidden="true" />
            {REPORT_COPY.fallbackPin}
          </Button>

          <Button
            type="button"
            variant={showAddressField ? 'primary' : 'outline'}
            size="lg"
            className="w-full sm:w-auto"
            aria-expanded={showAddressField}
            aria-controls="report-location-address"
            onClick={() => {
              setAddress('');
              manual.setTypedAddress('');
            }}
          >
            <PencilLine aria-hidden="true" />
            {REPORT_COPY.fallbackAddress}
          </Button>

          <Button
            type="button"
            variant={manual.choice === 'none' ? 'primary' : 'ghost'}
            size="lg"
            className="w-full sm:w-auto"
            onClick={manual.chooseNone}
          >
            {REPORT_COPY.fallbackSkip}
          </Button>
        </div>

        {pickerOpen ? (
          <PinPickerMap
            near={
              location.lat !== null && location.lng !== null
                ? { lat: location.lat, lng: location.lng }
                : null
            }
            onConfirm={(point, zoom) => {
              manual.confirmManualPin(point, zoom);
              setPickerOpen(false);
            }}
            onCancel={() => setPickerOpen(false)}
          />
        ) : null}

        {showAddressField ? (
          <div className="flex flex-col gap-1.5 pt-1" id="report-location-address">
            <Input
              id="report-location-address-input"
              label="Type the address"
              helperText="We will look it up when you send. You will get a map label, not an exact position."
              placeholder="For example: 1600 Pennsylvania Ave NW, Washington"
              value={address}
              maxLength={200}
              onChange={(event) => setAddress(event.target.value)}
              onBlur={() => manual.setTypedAddress(address)}
              autoComplete="street-address"
            />
            <p className="text-xs text-muted">{noteFor(method)}</p>
          </div>
        ) : (
          <p className="text-xs text-secondary">{noteFor(method)}</p>
        )}
      </div>
    </div>
  );
}

/**
 * A human description of what was captured, without overstating it.
 *
 * For a geocoded address this shows the text and says it will be looked up, because
 * there is no point yet and the panel must not imply one. For a real fix it shows
 * the coordinates. `placeName` is preferred when present because it is more useful
 * than a decimal pair, but a decimal pair is shown rather than nothing when that is
 * all there is.
 */
function describeLocation(location: ReportLocation): string {
  if (location.placeName !== null && location.placeName.trim().length > 0) {
    return location.source === 'address_text'
      ? `${location.placeName} (we will look this up when you send)`
      : location.placeName;
  }
  if (location.lat !== null && location.lng !== null) {
    return `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`;
  }
  return 'No place name available.';
}

/** The draft's method, derived from the real source rather than remembered. */
function methodFor(source: ReportLocation['source']): LocationMethod {
  if (source === 'gps') return 'gps';
  if (source === 'manual_pin') return 'pin';
  if (source === 'address_text') return 'address';
  if (source === 'none') return 'skipped';
  return 'none';
}

/** Each fallback states plainly whether it did anything. */
function noteFor(method: LocationMethod): string {
  if (method === 'pin') return REPORT_COPY.fallbackPinNote;
  if (method === 'address') return REPORT_COPY.fallbackAddressNote;
  if (method === 'skipped') return REPORT_COPY.fallbackSkipNote;
  return REPORT_COPY.fallbackNone;
}

/** Local copy of the empty draft location, so this panel owns no import of it. */
const NO_LOCATION: ReportLocation = {
  source: 'none',
  accuracyM: null,
  accuracyGrade: 'unknown',
  placeName: null,
  lat: null,
  lng: null,
};