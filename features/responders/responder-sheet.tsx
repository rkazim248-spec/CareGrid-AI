'use client';

import * as React from 'react';
import Link from 'next/link';

import {
  Badge,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui';
import { RelativeTime } from '@/components/domain';
import { DemoDataBadge } from '@/components/feedback';
import { resourceName } from '@/config';
import { formatDistance, formatDuration } from '@/lib/format';
import { MOCK_INCIDENTS } from '@/lib/mock-data';
import type { Responder } from '@/types';
import {
  ResponderStatusBadge,
  ResponderVerificationBadge,
} from '@/features/responders/responder-status-badge';

/**
 * ResponderSheet — the row-activated detail view on `/responders` (docs/04
 * §5.14, §13.11).
 *
 * A `Sheet`, not a route: the spec's own `DECISION REQUIRED` notes there is no
 * `/responders/[id]` route in v1, so the drawer is the detail view. Everything
 * the roster row cannot fit lives here — phone, certifications, the verification
 * note, and the assignment history.
 *
 * The phone number is present because this view is dispatcher/admin only. It is
 * never rendered on `/map`, never in a candidate list, and never to a citizen
 * (docs/22 §4.1).
 */
export function ResponderSheet({
  responder,
  onOpenChange,
}: {
  responder: Responder | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  if (!responder) return null;

  const incident = responder.activeIncidentId
    ? MOCK_INCIDENTS.find((i) => i.incidentId === responder.activeIncidentId)
    : undefined;

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{responder.displayName}</SheetTitle>
          <SheetDescription>
            The full responder record. A dispatcher and an administrator can see the phone number
            and the verification note; nobody else can.
          </SheetDescription>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <DemoDataBadge />
            <ResponderStatusBadge status={responder.status} size="md" />
            <ResponderVerificationBadge verification={responder.verification} size="md" />
          </span>
        </SheetHeader>

        <SheetBody>
          <dl className="flex flex-col gap-5">
            <Detail label="Phone">
              {responder.phone ? (
                <a href={`tel:${responder.phone}`} className="font-mono text-primary">
                  {responder.phone}
                </a>
              ) : (
                <span className="text-muted">Not provided</span>
              )}
            </Detail>

            <Detail label="Service radius">{formatDistance(responder.serviceRadiusM)}</Detail>

            <Detail label="Last location fix">
              {responder.lastLocationAt ? (
                <RelativeTime iso={responder.lastLocationAt} />
              ) : (
                <span className="text-muted">Never reported</span>
              )}
              {responder.staleLocation ? (
                <p className="mt-1 text-xs text-warning">
                  Older than 15 minutes. This responder is badged and listed last for assignments.
                </p>
              ) : null}
            </Detail>

            <Detail label="Active incident">
              {incident ? (
                <Link
                  href={`/incidents/${incident.incidentId}`}
                  className="ref-code text-accent"
                >
                  {incident.reference}
                </Link>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Detail>

            <Detail label="Capabilities">
              <span className="flex flex-wrap gap-1">
                {responder.capabilities.map((id) => (
                  <Badge key={id} variant="outline" size="sm">
                    {resourceName(id)}
                  </Badge>
                ))}
              </span>
            </Detail>

            <Detail label="Certifications">
              <ul className="flex flex-col gap-1">
                {responder.certifications.map((certification) => (
                  <li key={certification.name} className="text-sm text-secondary">
                    {certification.name}
                    <span className="text-xs text-muted">
                      {certification.expiresAt
                        ? ` — valid to ${certification.expiresAt.slice(0, 10)}`
                        : ' — no expiry recorded'}
                    </span>
                  </li>
                ))}
              </ul>
            </Detail>

            <Detail label="Verification note">
              {responder.verificationNote ? (
                <span className="text-secondary">{responder.verificationNote}</span>
              ) : (
                <span className="text-muted">No note recorded.</span>
              )}
            </Detail>

            <Detail label="Assignment history">
              <span className="flex flex-col gap-0.5 text-secondary tabular">
                <span>
                  {responder.stats.acceptedAssignments} accepted of{' '}
                  {responder.stats.totalAssignments} assignments
                </span>
                <span>
                  Average response{' '}
                  {responder.stats.avgResponseSec === null
                    ? 'not recorded'
                    : formatDuration(responder.stats.avgResponseSec)}
                </span>
              </span>
            </Detail>
          </dl>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="uppercase-label text-muted">{label}</dt>
      <dd className="text-sm text-primary">{children}</dd>
    </div>
  );
}
