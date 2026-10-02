'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, MapPin, Siren } from 'lucide-react';
import type { z } from 'zod';

import { ErrorState, EmptyState } from '@/components/feedback';
import { RoleBadge, StatusBadge, Timestamp, UrgencyBadge } from '@/components/domain';
import { Button, Card, CardContent } from '@/components/ui';
import { listIncidents } from '@/lib/api/client';
import { useSession } from '@/components/providers/session-provider';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];
type IncidentList = z.infer<typeof incidentListResponseSchema>;

export function DashboardView() {
  const { user, role } = useSession();
  const [items, setItems] = React.useState<readonly IncidentRow[]>([]);
  const [scope, setScope] = React.useState<IncidentList['scope'] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);

    void listIncidents({ limit: '6' }, { signal: controller.signal })
      .then((result) => {
        setItems(result.items);
        setScope(result.scope);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reload]);

  if (user === null || role === null) return null;

  const displayName = user.displayName?.trim() || 'Your account';

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <RoleBadge role={role} size="sm" />
          <h1 className="text-balance text-3xl leading-tight font-semibold tracking-tight text-primary sm:text-4xl">
            Welcome, {displayName}
          </h1>
          <p className="max-w-[65ch] text-sm leading-6 text-secondary">
            Your account and the reports you are permitted to view, refreshed from CareGrid.
          </p>
        </div>
        <Button asChild size="lg" className="min-h-12 self-start">
          <Link href="/report">
            <Siren aria-hidden="true" />
            Report an emergency
          </Link>
        </Button>
      </header>

      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted">Signed in as</p>
            <p className="mt-1 truncate text-sm font-medium text-primary">{user.email}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted">Account type</p>
            <p className="mt-1 text-sm font-medium capitalize text-primary">{role}</p>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="dashboard-reports-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="dashboard-reports-title" className="text-xl font-semibold text-primary">
              Recent reports
            </h2>
            <p className="mt-1 text-sm text-secondary">
              {scope?.complete === false
                ? scope.limitedReason ?? 'This list is limited to reports available to your account.'
                : 'The latest saved incidents available to your account.'}
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/incidents">
              View all reports
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {loading ? (
          <ul className="flex flex-col gap-3" aria-label="Loading reports">
            {[0, 1, 2].map((index) => (
              <li key={index} className="skeleton-fill h-24 rounded-card" />
            ))}
          </ul>
        ) : failed ? (
          <ErrorState
            title="We could not load your dashboard"
            description="Your account is signed in, but the incident list did not load. Check your connection and retry."
            onRetry={() => setReload((value) => value + 1)}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Siren}
            title="No reports to show"
            description="When you submit a report, its saved status and details will appear here."
            action={{ label: 'Report an emergency', href: '/report' }}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((incident) => (
              <li key={incident.incidentId}>
                <Link
                  href={`/incidents/${incident.incidentId}`}
                  className="block rounded-card focus-visible:ring-[2px] focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app focus-visible:outline-none"
                >
                  <Card className="transition-colors hover:border-strong">
                    <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="ref-code text-xs text-primary">{incident.reference}</span>
                          <StatusBadge status={incident.status} size="sm" />
                          <UrgencyBadge urgency={incident.urgency} size="sm" />
                        </div>
                        <p className="clamp-2 max-w-[72ch] text-sm text-secondary">
                          {incident.summary}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                          {incident.placeName ? (
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                              <span className="truncate">{incident.placeName}</span>
                            </span>
                          ) : null}
                          {incident.createdAt ? <Timestamp iso={incident.createdAt.toISOString()} /> : null}
                        </div>
                      </div>
                      <span className="text-sm font-medium text-accent">Open details</span>
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
