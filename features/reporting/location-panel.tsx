'use client';

import * as React from 'react';
import { Crosshair, MapPinOff, PencilLine, Pin } from 'lucide-react';

import { Button, Separator } from '@/components/ui';
import { LocationBadge } from '@/components/domain';
import { REPORT_COPY, DEMO_REFERENCE } from '@/features/reporting/report-copy';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import type { LocationMethod, ReportLocation } from '@/features/reporting/report-types';

/**
 * Location panel — docs/04 §13.2 (`useGeolocation` + `LocationFallback`).
 *
 * `navigator.geolocation` is NOT called in Phase 1. The permission prompt is a
 * real cost and a real privacy moment; spending it to produce a fabricated
 * coordinate would be dishonest (docs/04 §15.1). The accuracy badge and place
 * name shown after the press come from the demo dataset, and the helper text
 * says so.
 *
 * The accuracy is never described more precisely than it is. "Approximate
 * ±34 m" is what the badge says, because that is what the badge is
 * (docs/04 §14.3).
 */
const DEMO_LOCATION =
  MOCK_INCIDENTS.find((incident) => incident.reference === DEMO_REFERENCE)?.location ?? null;

const FINDING_MS = 700;

export function LocationPanel({
  location,
  method,
  onChange,
}: {
  location: ReportLocation;
  method: LocationMethod;
  onChange: (location: ReportLocation, method: LocationMethod) => void;
}) {
  const [finding, setFinding] = React.useState(false);

  const useCurrentLocation = React.useCallback(() => {
    setFinding(true);
    window.setTimeout(() => {
      setFinding(false);
      if (DEMO_LOCATION) {
        onChange(
          {
            source: 'gps',
            accuracyM: DEMO_LOCATION.accuracyM,
            accuracyGrade: DEMO_LOCATION.accuracyGrade,
            placeName: DEMO_LOCATION.placeName,
          },
          'gps',
        );
      } else {
        onChange({ source: 'none', accuracyM: null, accuracyGrade: 'unknown', placeName: null }, 'gps');
      }
    }, FINDING_MS);
  }, [onChange]);

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-[72ch] text-sm text-secondary">{REPORT_COPY.locationLead}</p>

      <Button
        type="button"
        variant="primary"
        size="lg"
        className="w-full sm:w-auto"
        loading={finding}
        onClick={useCurrentLocation}
      >
        {!finding ? <Crosshair aria-hidden="true" /> : null}
        {REPORT_COPY.useCurrentLocation}
      </Button>

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
          <p className="text-sm text-secondary">{location.placeName ?? 'No place name available.'}</p>
          <p className="text-xs text-muted">
            From the demonstration dataset. The browser location API is not called in this build.
          </p>
        </div>
      )}

      <Separator className="my-1" />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-primary">{REPORT_COPY.fallbackTitle}</p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() =>
              onChange(
                {
                  source: 'manual_pin',
                  accuracyM: null,
                  accuracyGrade: 'unknown',
                  placeName: null,
                },
                'pin',
              )
            }
          >
            <Pin aria-hidden="true" />
            {REPORT_COPY.fallbackPin}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() =>
              onChange(
                {
                  source: 'address_text',
                  accuracyM: null,
                  accuracyGrade: 'unknown',
                  placeName: null,
                },
                'address',
              )
            }
          >
            <PencilLine aria-hidden="true" />
            {REPORT_COPY.fallbackAddress}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full sm:w-auto"
            onClick={() =>
              onChange(
                { source: 'none', accuracyM: null, accuracyGrade: 'unknown', placeName: null },
                'skipped',
              )
            }
          >
            {REPORT_COPY.fallbackSkip}
          </Button>
        </div>

        <p className="text-xs text-secondary">{noteFor(method)}</p>
      </div>
    </div>
  );
}

/** Each fallback states plainly whether it did anything. */
function noteFor(method: LocationMethod): string {
  if (method === 'pin') return REPORT_COPY.fallbackPinNote;
  if (method === 'address') return REPORT_COPY.fallbackAddressNote;
  if (method === 'skipped') return REPORT_COPY.fallbackSkipNote;
  return REPORT_COPY.fallbackNone;
}
