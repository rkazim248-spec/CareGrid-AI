'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, MapPin, Package, X } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Progress,
  Separator,
  Textarea,
} from '@/components/ui';
import { UrgencyBadge } from '@/components/domain';
import { CATEGORY_META, REPORT_LIMITS, resourceName } from '@/config';
import { formatClock, formatCountdown, formatDistance } from '@/lib/format';
import { useDispatchResponse } from '@/features/dispatch/use-dispatch-response';
import type { AlertIncident, LiveDispatchRow } from '@/features/dispatch/live-dispatch-row';

/**
 * ResponderAlertDialog — the full-screen emergency dispatch alert (Phase 13
 * brief §3). Everything a responder needs to decide, in the brief's order:
 * category, priority, location, distance, required resources, time reported —
 * and exactly two actions: Accept and Decline.
 *
 * Data comes from two live listeners (L6 dispatch + L2a alert-target incident),
 * so `incident` may briefly lag `dispatch`. Every incident-derived field says
 * "Loading…" rather than inventing a value, and the fields the dispatch row
 * really has (distance, incident link, response window) render immediately.
 *
 * Honesty rules baked in:
 *   - NO travel-time row. `etaSec` is always null in this system (brief §30);
 *     claiming an estimate would be fabrication.
 *   - No raw coordinates — the place name only.
 *   - The decline reason is OPTIONAL (brief §16); only the length cap applies.
 *   - The dispatcher is notified in-app by the server on both answers, and the
 *     copy claims nothing beyond that (no SMS/WhatsApp/push wording).
 */

export type ResponderAlertDialogProps = {
  dispatch: LiveDispatchRow;
  incident: AlertIncident | null;
  open: boolean;
  onClose: () => void;
};

export function ResponderAlertDialog({ dispatch, incident, open, onClose }: ResponderAlertDialogProps) {
  const [declineReason, setDeclineReason] = React.useState('');
  const [now, setNow] = React.useState(() => Date.now());
  const { respond, pending } = useDispatchResponse(onClose);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  // All hooks above the guard — the previous version returned before its hooks
  // and crashed on the first render without a dispatch.
  if (!open) return null;

  const expiresAtMs = dispatch.expiresAt === null ? null : Date.parse(dispatch.expiresAt);
  const remainingSec =
    expiresAtMs === null
      ? null
      : Math.max(0, Math.round((expiresAtMs - now) / 1000));
  const windowClosed = remainingSec === 0;
  const ratio = remainingSec === null ? null : remainingSec / REPORT_LIMITS.dispatchExpirySec;

  const accept = () => respond('accept', dispatch.id);
  const decline = () => respond('decline', dispatch.id, declineReason.trim() || undefined);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader className="gap-3 border-b border-danger/30 pb-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-8 text-danger" aria-hidden="true" />
            <div className="min-w-0">
              <DialogTitle className="text-xl font-semibold text-primary">
                New emergency dispatch
              </DialogTitle>
              <DialogDescription className="text-secondary">
                You have been asked to respond. Review the details, then accept or decline.
              </DialogDescription>
            </div>
          </div>

          {ratio !== null && !windowClosed ? (
            <div className="flex flex-col gap-1">
              <Progress
                value={ratio}
                label={`${formatCountdown(remainingSec ?? 0)} left to respond`}
                fillClassName={remainingSec !== null && remainingSec <= 20 ? 'bg-danger' : 'bg-accent'}
                className="h-2"
              />
              <p className="text-right text-xs text-muted tabular">
                {formatCountdown(remainingSec ?? 0)} left to respond
              </p>
            </div>
          ) : null}
          {windowClosed ? (
            <p className="text-sm font-medium text-danger" role="status">
              The response window has closed. The dispatcher can reassign — you can still decline
              to clear it.
            </p>
          ) : null}
        </DialogHeader>

        <div className="flex flex-col gap-4 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {incident ? (
              <>
                <span className="text-sm font-medium text-secondary">
                  {CATEGORY_META[incident.category].label}
                </span>
                <UrgencyBadge
                  urgency={incident.urgency}
                  size="lg"
                  {...(incident.urgencyIsDefaulted ? { source: 'fallback' as const } : {})}
                />
              </>
            ) : (
              <p className="text-sm text-muted">Loading incident details…</p>
            )}
          </div>

          <p className="text-sm text-secondary">
            Incident{' '}
            <Link
              href={`/incidents/${dispatch.incidentId}`}
              className="ref-code font-medium text-accent underline-offset-4 hover:underline"
            >
              {incident?.reference ?? dispatch.incidentId}
            </Link>
          </p>

          <Separator />

          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-start gap-3">
              <MapPin className="mt-0.5 size-5 shrink-0 text-secondary" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="uppercase-label text-muted">Location</dt>
                <dd className="text-sm font-medium text-primary">
                  {incident === null ? 'Loading…' : (incident.placeName ?? 'Location not recorded')}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-secondary" aria-hidden="true" />
              <div>
                <dt className="uppercase-label text-muted">Distance</dt>
                <dd className="text-sm font-medium text-primary tabular">
                  {formatDistance(dispatch.distanceM)}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Package className="mt-0.5 size-5 shrink-0 text-secondary" aria-hidden="true" />
              <div className="min-w-0">
                <dt className="uppercase-label text-muted">Reported at</dt>
                <dd className="text-sm font-medium text-primary tabular">
                  {incident?.createdAt ? formatClock(incident.createdAt) : '—'}
                </dd>
              </div>
            </div>
          </dl>

          <div>
            <p className="uppercase-label mb-2 text-muted">Required resources</p>
            <div className="flex flex-wrap gap-2">
              {incident === null ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : incident.resources.length === 0 ? (
                <p className="text-sm text-muted">None recorded</p>
              ) : (
                incident.resources.map((resource) => (
                  <span
                    key={resource.resourceId}
                    className="rounded-full border border-control bg-elevated px-2.5 py-0.5 text-xs text-secondary"
                  >
                    {resourceName(resource.resourceId)} × {resource.quantity}
                  </span>
                ))
              )}
            </div>
          </div>

          <Alert tone="info" className="border-info/30">
            <AlertIcon tone="info" />
            <div className="flex min-w-0 flex-col gap-1">
              <AlertTitle>Your answer</AlertTitle>
              <AlertDescription>
                Accepting tells the dispatcher you are on your way; declining hands the assignment
                back. Either answer reaches the dispatcher as an in-app notification, and the
                reason below is optional.
              </AlertDescription>
            </div>
          </Alert>

          <Textarea
            label="Reason for declining (optional)"
            helperText="Helps the dispatcher pick the next responder. Nothing is sent anywhere else."
            placeholder="e.g. already on another call, not equipped for this incident type"
            rows={3}
            maxChars={REPORT_LIMITS.reasonMaxChars}
            showCount
            value={declineReason}
            onChange={(event) => setDeclineReason(event.target.value)}
            disabled={pending}
          />

          <DialogFooter className="flex-col gap-2 border-t pt-4 sm:flex-row">
            <Button
              variant="danger-outline"
              size="lg"
              className="min-h-12 flex-1 sm:min-h-11"
              onClick={decline}
              loading={pending}
            >
              <X aria-hidden="true" />
              Decline
            </Button>
            <Button
              variant="danger"
              size="lg"
              className="min-h-12 flex-1 sm:min-h-11"
              onClick={accept}
              disabled={windowClosed}
              loading={pending}
            >
              <Check aria-hidden="true" />
              Accept dispatch
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
