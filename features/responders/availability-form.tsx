'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Button, CheckboxField, Card, CardContent, Input, Slider, SwitchField } from '@/components/ui';
import { REPORT_LIMITS, RESOURCE_CATALOGUE } from '@/config';
import { formatDistance } from '@/lib/format';
import type { Responder } from '@/types';

/**
 * AvailabilityForm — the responder's own profile (docs/04 §13.11 mobile, US-010,
 * FR-062, FR-064).
 *
 * Four fields and a save button, in the order §13.11's mobile wireframe uses:
 * availability, capabilities, service radius, phone. Nothing else appears here —
 * a responder editing their own record has no use for a verification column they
 * cannot change, so it is not rendered at all rather than rendered disabled.
 *
 * The 56 px availability switch is the most important control on the screen and
 * it carries the reason it is unavailable when the account is not yet verified
 * (US-010 AC3, docs/04 §10.4).
 *
 * `Save changes` shows a spinner with the label preserved, then a `success`
 * toast. Nothing is sent: Phase 1 has no API (docs/04 §9.8).
 */

const AWAITING_VERIFICATION_REASON = 'Your account is awaiting admin verification';
const SERVICE_RADIUS_MIN = 500;
const SERVICE_RADIUS_MAX = 50_000;
/** The slider's accessible name. A literal `aria-label` in JSX is banned by lint. */
const RADIUS_SLIDER_LABEL = 'Service radius in metres';
const AVAILABILITY_REGION = 'Availability';

export function AvailabilityForm({ self }: { self: Responder }) {
  const blocked = self.verification !== 'verified';

  const [available, setAvailable] = React.useState(self.status === 'available');
  const [capabilities, setCapabilities] = React.useState<readonly string[]>(self.capabilities);
  const [radius, setRadius] = React.useState(self.serviceRadiusM);
  const [phone, setPhone] = React.useState(self.phone ?? '');
  const [saving, setSaving] = React.useState(false);

  // The timer is the ONLY thing this component schedules, and it is cleared on
  // unmount. A save that resolves after the component is gone would call
  // `setSaving` on a dead component and, worse, would have shown a success toast
  // for a form the user can no longer see.
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const toggle = (resourceId: string) => {
    setCapabilities((current) =>
      current.includes(resourceId)
        ? current.filter((id) => id !== resourceId)
        : [...current, resourceId],
    );
  };

  const save = () => {
    setSaving(true);
    timer.current = setTimeout(() => {
      setSaving(false);
      toast.success('Your details were saved.', {
        description: `Demo build — nothing was sent. Availability, ${capabilities.length} capabilities, ${formatDistance(radius)} radius.`,
      });
    }, 700);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 py-4">
        <section aria-label={AVAILABILITY_REGION} className="rounded-card border border-subtle p-3">
          <SwitchField
            id="self-availability"
            label={available ? 'Available for assignments' : 'Offline'}
            helperText="Dispatchers can see you while you are available."
            {...(blocked
              ? { disabled: true, disabledReason: AWAITING_VERIFICATION_REASON }
              : {})}
            checked={available}
            onCheckedChange={setAvailable}
            className="min-h-14 py-3"
          />
        </section>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium text-secondary">
            What you can help with
          </legend>
          <p className="text-xs text-secondary">
            Choose everything you are trained and equipped for. A dispatcher only sees you for
            incidents that match.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {RESOURCE_CATALOGUE.map((resource) => (
              <CheckboxField
                key={resource.resourceId}
                id={`cap-${resource.resourceId}`}
                label={resource.name}
                checked={capabilities.includes(resource.resourceId)}
                onCheckedChange={() => toggle(resource.resourceId)}
              />
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Input
                id="service-radius"
                label="Service radius"
                type="number"
                inputMode="numeric"
                min={SERVICE_RADIUS_MIN}
                max={SERVICE_RADIUS_MAX}
                step={100}
                value={radius}
                onChange={(event) => setRadius(clampRadius(event.target.value))}
                helperText="How far you are willing to travel, in metres. A dispatcher uses this with your location."
              />
            </div>
            <p className="pb-2 text-sm text-secondary tabular">{formatDistance(radius)}</p>
          </div>
          <Slider
            aria-label={RADIUS_SLIDER_LABEL}
            min={SERVICE_RADIUS_MIN}
            max={SERVICE_RADIUS_MAX}
            step={100}
            value={[radius]}
            onValueChange={([value]) => setRadius(value ?? SERVICE_RADIUS_MIN)}
          />
          <p className="text-xs text-muted">
            Between {SERVICE_RADIUS_MIN} m and {formatDistance(SERVICE_RADIUS_MAX)}.
          </p>
        </div>

        <Input
          id="self-phone"
          type="tel"
          inputMode="tel"
          label="Phone"
          value={phone}
          maxLength={REPORT_LIMITS.searchMaxChars}
          onChange={(event) => setPhone(event.target.value)}
          helperText="Only a dispatcher and an administrator can see this. It is never shown on the map or in a public list."
          autoComplete="tel"
        />

        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" loading={saving} onClick={save}>
            Save changes
          </Button>
          <p className="text-xs text-muted">
            Demo record. Nothing you change here is sent anywhere.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function clampRadius(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return SERVICE_RADIUS_MIN;
  return Math.min(SERVICE_RADIUS_MAX, Math.max(SERVICE_RADIUS_MIN, parsed));
}
