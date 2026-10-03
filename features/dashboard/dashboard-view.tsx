'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Activity, ArrowUpRight, Bell, ClipboardList, Map, MapPin, RefreshCw, Siren } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { z } from 'zod';

import { EmptyState } from '@/components/feedback';
import { RoleBadge, StatusBadge, Timestamp, UrgencyBadge } from '@/components/domain';
import { Alert, AlertDescription, AlertIcon, AlertTitle, Button, Card, CardContent } from '@/components/ui';
import { listIncidents } from '@/lib/api/client';
import { useSession } from '@/components/providers/session-provider';
import { useRealtimeNotifications } from '@/features/notifications/use-realtime-notifications';
import { MyReportCard } from '@/features/incidents/my-report-card';
import type { incidentListResponseSchema } from '@/validators/incident';

type IncidentRow = z.infer<typeof incidentListResponseSchema>['items'][number];
type IncidentList = z.infer<typeof incidentListResponseSchema>;

export function DashboardView() {
  const { user, role } = useSession();
  const notifications = useRealtimeNotifications();
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

  const terminal = new Set(['resolved', 'closed', 'cancelled', 'false_alarm', 'merged']);
  const activeItems = items.filter((item) => !terminal.has(item.status));
  const activeCount = activeItems.length;
  const resolvedCount = items.filter((item) => item.status === 'resolved' || item.status === 'closed').length;
  const pendingCount = items.filter((item) => item.status === 'new').length;
  const notificationValue = notifications.error
    ? 'Unavailable'
    : notifications.hasReceivedSnapshot
      ? String(notifications.unreadCount)
      : 'Loading';
  const overview = [
    { label: 'Active reports', value: loading ? 'Loading' : failed ? '—' : String(activeCount), detail: 'In the latest reports', icon: Activity },
    { label: 'Resolved reports', value: loading ? 'Loading' : failed ? '—' : String(resolvedCount), detail: 'In the latest reports', icon: ClipboardList },
    { label: 'Pending reports', value: loading ? 'Loading' : failed ? '—' : String(pendingCount), detail: 'Awaiting review', icon: Siren },
    { label: 'Community activity', value: notificationValue, detail: 'Unread updates in your feed', icon: Bell },
  ];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm font-semibold text-accent">CareGrid AI</p>
          <h1 className="text-balance text-3xl leading-tight font-semibold tracking-tight text-primary sm:text-4xl">
            Good to see you.
          </h1>
          <p className="max-w-[65ch] text-base leading-7 text-secondary">
            Monitor your reports and respond when your community needs help.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span className="max-w-full truncate">{user.email}</span>
            <span aria-hidden="true" className="hidden size-1 rounded-full bg-default sm:inline-block" />
            <RoleBadge role={role} size="sm" />
          </div>
        </div>
        <Button asChild size="lg" className="min-h-12 w-full sm:w-auto">
          <Link href="/report">
            <Siren aria-hidden="true" />
            Report an Emergency
          </Link>
        </Button>
      </header>

      {failed ? (
        <Alert tone="warning" role="status" className="items-center">
          <AlertIcon tone="warning" />
          <div className="min-w-0 flex-1">
            <AlertTitle>Incident services are temporarily unavailable</AlertTitle>
            <AlertDescription>
              Your dashboard is available, but incident data could not be loaded.
            </AlertDescription>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" />
            Retry
          </Button>
        </Alert>
      ) : null}

      <section aria-label="Report overview">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-primary">Your response overview</h2>
          <p className="text-xs text-muted">Counts reflect the latest 6 reports shown below.</p>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {overview.map((metric) => {
            const Icon = metric.icon;
            return (
              <li key={metric.label} className="min-w-0 rounded-card border border-subtle bg-surface p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-secondary">{metric.label}</p>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-muted text-accent">
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                </div>
                <p className="mt-4 break-words text-2xl font-semibold tracking-tight text-primary tabular-nums">
                  {metric.value}
                </p>
                <p className="mt-1 text-xs text-muted">{metric.detail}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="dashboard-active-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="dashboard-active-title" className="text-xl font-semibold text-primary">
              Active emergencies
            </h2>
            <p className="mt-1 text-sm text-secondary">Open reports from the latest six incidents.</p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/incidents">
              View all reports
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {loading ? (
          <ul className="flex flex-col gap-3" aria-label="Loading active incidents">
            {[0, 1].map((index) => <li key={index} className="skeleton-fill h-24 rounded-card" />)}
          </ul>
        ) : failed ? (
          <p className="text-sm text-secondary">
            Active emergency data will appear here when the incident service responds.
          </p>
        ) : activeItems.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No active emergencies"
            description="No open incidents are present in the latest reports available to your account."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {activeItems.slice(0, 3).map((incident) => (
              <MyReportCard key={incident.incidentId} incident={incident} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="dashboard-actions-title">
        <h2 id="dashboard-actions-title" className="mb-3 text-lg font-semibold text-primary">Quick actions</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuickAction href="/report" icon={Siren} label="Report an emergency" detail="Share a new incident report" />
          <QuickAction href="/incidents" icon={ClipboardList} label="My reports" detail="Review saved incident details" />
          {role !== 'citizen' ? (
            <QuickAction href="/map" icon={Map} label="View map" detail="Review incidents by location" />
          ) : (
            <QuickAction href="/notifications" icon={Bell} label="Notifications" detail="See recent report updates" />
          )}
        </div>
      </section>

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
          <p className="text-sm text-secondary">
            Recent report data is temporarily unavailable.
          </p>
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
                        <p className="clamp-2 max-w-[72ch] text-sm leading-6 text-secondary">
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

function QuickAction({
  href,
  icon: Icon,
  label,
  detail,
}: {
  href: Route;
  icon: LucideIcon;
  label: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-[76px] items-center gap-3 rounded-card border border-subtle bg-surface px-4 py-3 transition-[border-color,background-color,transform] duration-200 ease-out hover:-translate-y-px hover:border-selected hover:bg-elevated focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-muted text-accent">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-primary">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-secondary">{detail}</span>
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted transition-transform duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}
