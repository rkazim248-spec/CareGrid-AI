'use client';

import * as React from 'react';
import { ShieldCheck, UserCog, Database, Activity } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { KpiTile } from '@/components/domain/kpi-tile';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { RoleBadge } from '@/components/domain/role-badge';
import { RelativeTime } from '@/components/domain/timestamp';
import { DataTable } from '@/components/table';
import { TableCell, TableRow } from '@/components/ui/table';
import { EmptyState, EMPTY_COPY, DemoDataBadge } from '@/components/feedback';
import { UserCheck } from 'lucide-react';
import { PageHeader } from '@/components/layout';
import {
  MOCK_AUDIT_ENTRIES,
  MOCK_DASHBOARD_TILES,
  MOCK_RESPONDERS,
  MOCK_SYSTEM_HEALTH,
  MOCK_USERS,
} from '@/lib/mock-data';
import { formatCount, formatPercent } from '@/lib/format';
import { SELF_ROLE_CHANGE_REASON } from '@/config/roles';
import type { AuditEntry, Responder } from '@/types/domain';

/**
 * /admin — the administrator's landing page. docs/04 §13.17
 *
 * The visual hierarchy here is TRUST FIRST (docs/04 §12.4): the pending
 * responder queue and the last privileged actions are above the fold, and
 * system health is a side column. An admin's actual job is accountability, not
 * operating the queue, so the live incident queue is deliberately absent.
 *
 * Every action on this page is reason-gated and audited. The buttons are
 * UI-only in Phase 1; what must be reviewed is that each one SAYS what it will
 * record, because that copy is the audit affordance.
 */
export function AdminOverviewView() {
  const pending = MOCK_RESPONDERS.filter((r) => r.verification === 'pending');
  const recentAudit = MOCK_AUDIT_ENTRIES.slice(0, 5);
  const suspended = MOCK_USERS.filter((u) => u.status === 'suspended').length;
  const health = MOCK_SYSTEM_HEALTH;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Administration"
        description="Platform trust, account state, and the record of every privileged action."
        meta={
          <div className="flex items-center gap-2">
            <DemoDataBadge />
            <span className="text-xs text-muted">
              Every action on this page is written to the audit log with your name and a reason.
            </span>
          </div>
        }
        actions={[
          {
            label: `Review pending responders (${pending.length})`,
            href: '/admin/responders' as Route,
            variant: 'primary',
            icon: UserCheck,
            disabledReason: pending.length === 0 ? 'No responders are waiting for review' : undefined,
          },
        ]}
      />

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Trust queue — 2/3 */}
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Responder verification queue</CardTitle>
              <p className="text-sm text-secondary">
                Approving makes a responder assignable to incidents. Unverified responders are never
                offered in a candidate list.
              </p>
            </CardHeader>
            <CardContent>
              {pending.length === 0 ? (
                <EmptyState
                  icon={UserCog}
                  title={EMPTY_COPY.verifications.title}
                  description={EMPTY_COPY.verifications.description}
                />
              ) : (
                <ul className="flex flex-col divide-y divide-subtle">
                  {pending.map((responder) => (
                    <PendingResponderRow key={responder.uid} responder={responder} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Last privileged actions</CardTitle>
              <p className="text-sm text-secondary">
                The five most recent audited actions. Entries are append-only: no role, including
                administrator, can change or remove them.
              </p>
            </CardHeader>
            <CardContent className="px-0">
              {recentAudit.length === 0 ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="No privileged actions in the last 24 hours"
                  description="Role changes, responder decisions, and configuration edits appear here."
                />
              ) : (
                <DataTable
                  caption="Five most recent privileged actions"
                  headers={['When', 'Actor', 'Action', 'Entity', 'Reason']}
                  rowLabel={`${recentAudit.length} entries shown`}
                >
                  {recentAudit.map((entry) => (
                    <AuditRow key={entry.logId} entry={entry} />
                  ))}
                </DataTable>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Health + operational — 1/3 */}
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <KpiTile
              label="Pending verifications"
              value={pending.length}
              asOfIso="2026-09-26T10:12:00.000Z"
              variant={pending.length > 0 ? 'critical' : 'default'}
            />
            <KpiTile
              label="Suspended accounts"
              value={suspended}
              asOfIso="2026-09-26T10:12:00.000Z"
              hint={suspended === 0 ? 'None' : 'Needs review'}
            />
            <KpiTile
              label="AI success rate"
              value={formatPercent(health.aiSuccessPct)}
              asOfIso="2026-09-26T07:00:00.000Z"
              hint="Last 24 hours"
            />
            <KpiTile
              label="AI fallback rate"
              value={formatPercent(health.aiFallbackPct)}
              asOfIso="2026-09-26T07:00:00.000Z"
              hint="Keyword triage, not failure"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-icon-md" aria-hidden="true" />
                System health
              </CardTitle>
              <p className="text-sm text-secondary">
                Measured from the platform&apos;s own counters, not estimated.
              </p>
            </CardHeader>
            <CardContent className="px-0">
              <DataTable
                caption="Platform health counters"
                headers={['Measure', 'Value', 'Limit']}
              >
                <TableRow>
                  <TableCell>Firestore reads</TableCell>
                  <TableCell className="text-right tabular">{formatCount(health.firestoreReads)}</TableCell>
                  <TableCell className="text-right text-muted">free tier</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Realtime listeners</TableCell>
                  <TableCell className="text-right tabular">
                    {health.listenersActive} / {health.listenersMax}
                  </TableCell>
                  <TableCell className="text-right text-muted">FR-091 cap</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Maintenance jobs</TableCell>
                  <TableCell className="text-right">
                    {health.maintenanceEnabled ? 'Enabled' : 'Disabled'}
                  </TableCell>
                  <TableCell className="text-right text-muted">ENABLE_MAINTENANCE_JOBS</TableCell>
                </TableRow>
              </DataTable>
            </CardContent>
            {!health.maintenanceEnabled ? (
              <div className="px-4 pb-4">
                <Alert tone="info">
                  <AlertTitle>Maintenance jobs are disabled in this deployment</AlertTitle>
                  <AlertDescription>
                    The control stays visible and disabled with this reason, rather than
                    disappearing.
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="size-icon-md" aria-hidden="true" />
                Operational
              </CardTitle>
              <p className="text-sm text-secondary">Read-only context, not a second console.</p>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-secondary">Active incidents</dt>
                <dd className="text-right tabular text-primary">{MOCK_DASHBOARD_TILES.active}</dd>
                <dt className="text-secondary">Unassigned</dt>
                <dd className="text-right tabular text-primary">{MOCK_DASHBOARD_TILES.unassigned}</dd>
                <dt className="text-secondary">Responders available</dt>
                <dd className="text-right tabular text-primary">
                  {MOCK_DASHBOARD_TILES.availableResponders}
                </dd>
                <dt className="text-secondary">SLA breached</dt>
                <dd className="text-right tabular text-danger">{MOCK_DASHBOARD_TILES.slaBreached}</dd>
              </dl>
              <Button variant="outline" className="mt-4 w-full" asChild>
                <Link href="/admin/audit-logs">Open the audit log</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PendingResponderRow({ responder }: { responder: Responder }) {
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={responder.displayName} size="md" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-primary">{responder.displayName}</p>
          <p className="truncate text-xs text-secondary">
            {responder.capabilities.length} declared capabilities ·{' '}
            {responder.certifications.length} certification
            {responder.certifications.length === 1 ? '' : 's'}
          </p>
          <p className="text-xs text-muted">Last fix {formatCount(0) ? '' : ''}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="primary" size="sm">
          Approve
        </Button>
        <Button variant="danger-outline" size="sm">
          Reject
        </Button>
      </div>
    </li>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <RelativeTime iso={entry.createdAt} />
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          <Avatar name={entry.actor.displayName} size="xs" />
          <span className="clamp-1">{entry.actor.displayName}</span>
          <RoleBadge role={entry.actor.role} size="sm" />
        </span>
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs text-secondary">{entry.action}</code>
      </TableCell>
      <TableCell>
        <code className="font-mono text-2xs text-muted">
          {entry.incidentRef ?? entry.entityId}
        </code>
      </TableCell>
      <TableCell>
        <span className="clamp-1 text-xs">{entry.reason ?? '—'}</span>
      </TableCell>
    </TableRow>
  );
}

export { SELF_ROLE_CHANGE_REASON };
