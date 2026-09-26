'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Archive, RotateCcw, Trash2, ScrollText, UserCheck, ShieldQuestion } from 'lucide-react';

import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SwitchField } from '@/components/ui/switch';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Avatar } from '@/components/ui/avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UrgencyBadge } from '@/components/domain/urgency-badge';
import { StatusBadge } from '@/components/domain/status-badge';
import { RoleBadge } from '@/components/domain/role-badge';
import { Timestamp, RelativeTime } from '@/components/domain/timestamp';
import {
  DemoDataBadge, EmptyState, EMPTY_COPY, RequestId,
} from '@/components/feedback';
import {
  MOCK_AUDIT_ENTRIES, MOCK_INCIDENTS, MOCK_RESPONDERS, MOCK_CURRENT_USER_UID,
} from '@/lib/mock-data';
import { CATEGORY_LIST, CATEGORY_META } from '@/config/categories';
import { STATUS_META } from '@/config/statuses';
import { INCIDENT_STATUSES, AUDIT_ACTIONS } from '@/types/enums';
import { REPORT_LIMITS } from '@/config/limits';
import { formatAuditStamp, formatAbsolute, formatDate } from '@/lib/format';
import type { AuditEntry, Incident } from '@/types/domain';

/* ========================================================================== */
/* /admin/incidents — docs/04 §13.19                                          */
/* ========================================================================== */

export function AdminIncidentsView() {
  const [query, setQuery] = React.useState('');
  const [status, setStatus] = React.useState<'all' | (typeof INCIDENT_STATUSES)[number]>('all');
  const [includeDeleted, setIncludeDeleted] = React.useState(false);
  const [selected, setSelected] = React.useState<Incident | null>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return MOCK_INCIDENTS.filter((incident) => {
      if (!includeDeleted && incident.deletedAt) return false;
      if (status !== 'all' && incident.status !== status) return false;
      if (!q) return true;
      return (
        incident.reference.toLowerCase().includes(q) ||
        incident.summary.toLowerCase().includes(q) ||
        CATEGORY_META[incident.category].label.toLowerCase().includes(q)
      );
    });
  }, [query, status, includeDeleted]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Incident archive"
        description="Every incident, including soft-deleted ones. Restoring is reversible; hard deletion does not exist anywhere in this product."
        meta={<DemoDataBadge />}
        actions={[{ label: 'Export CSV', variant: 'outline', icon: Archive }]}
      />

      {includeDeleted ? (
        <Alert tone="warning">
          <AlertTitle>This view includes deleted incidents</AlertTitle>
          <AlertDescription>
            Every action you take here is recorded in the audit log.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-4">
          <SearchInput
            label="Search incidents"
            value={query}
            onValueChange={setQuery}
            onDebouncedChange={() => undefined}
            placeholder="Reference, summary, or category"
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary">Status</span>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger>
                <SelectValue placeholder="Any status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                {INCIDENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SwitchField
            id="include-deleted"
            label="Include deleted incidents"
            helperText="Soft-deleted only. Nothing is ever hard-deleted."
            checked={includeDeleted}
            onCheckedChange={setIncludeDeleted}
          />
          <div className="flex items-end">
            <Button
              variant="ghost"
              onClick={() => { setQuery(''); setStatus('all'); setIncludeDeleted(false); }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={includeDeleted ? 'No deleted incidents in this period' : EMPTY_COPY.audit.title}
          description={
            includeDeleted
              ? 'Nothing has been deleted that matches these filters.'
              : 'Change the date range or clear the action filter to see more.'
          }
        />
      ) : (
        <div className="rounded-card border border-default bg-surface">
          <Table>
            <TableCaption className="sr-only">
              Incident archive. {filtered.length} incidents match the current filters.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Reference</TableHead>
                <TableHead scope="col">Category</TableHead>
                <TableHead scope="col">Priority</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Deleted</TableHead>
                <TableHead scope="col">Reason</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((incident) => (
                <TableRow
                  key={incident.incidentId}
                  data-state={selected?.incidentId === incident.incidentId ? 'selected' : undefined}
                >
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setSelected(incident)}
                      className="ref-code rounded-sm text-left text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
                    >
                      {incident.reference}
                      <span className="sr-only">. Open the record.</span>
                    </button>
                  </TableCell>
                  <TableCell>{CATEGORY_META[incident.category].label}</TableCell>
                  <TableCell>
                    <UrgencyBadge urgency={incident.urgency} size="sm" />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={incident.status} size="sm" />
                  </TableCell>
                  <TableCell>
                    {incident.deletedAt ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted">Deleted</span>
                        <Timestamp iso={incident.deletedAt} showDate={false} />
                        <code className="font-mono text-2xs text-muted">{incident.deletedBy}</code>
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {incident.deleteReason ? (
                      <span className="block max-w-64 rounded-sm border border-subtle bg-inset px-2 py-1 text-xs">
                        {incident.deleteReason}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {incident.deletedAt ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            toast('Restore requested', {
                              description:
                                'Phase 1 shell: nothing was sent. A real restore requires a reason and writes an audit entry.',
                            })
                          }
                        >
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                          Restore
                        </Button>
                      ) : null}
                      <Button
                        variant="danger-outline"
                        size="sm"
                        disabled={incident.status === 'closed'}
                        title={
                          incident.status === 'closed'
                            ? 'A closed incident cannot be deleted. It is retained for the audit trail.'
                            : 'Requires a reason of at least 10 characters'
                        }
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="p-0">
          <SheetHeader>
            <SheetTitle className="ref-code">{selected?.reference}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {selected ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
                <dt className="text-secondary">Status</dt>
                <dd><StatusBadge status={selected.status} /></dd>
                <dt className="text-secondary">Priority</dt>
                <dd><UrgencyBadge urgency={selected.urgency} /></dd>
                <dt className="text-secondary">Summary</dt>
                <dd className="max-w-[52ch]">{selected.summary}</dd>
                <dt className="text-secondary">Created</dt>
                <dd><Timestamp iso={selected.createdAt} /></dd>
                <dt className="text-secondary">Deleted</dt>
                <dd>{selected.deletedAt ? <Timestamp iso={selected.deletedAt} /> : '—'}</dd>
                <dt className="text-secondary">Deleted by</dt>
                <dd><code className="font-mono text-2xs">{selected.deletedBy ?? '—'}</code></dd>
                <dt className="text-secondary">Reason</dt>
                <dd>{selected.deleteReason ?? '—'}</dd>
              </dl>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ========================================================================== */
/* /admin/responders — docs/04 §13.20                                         */
/* ========================================================================== */

export function AdminRespondersView() {
  const [filter, setFilter] = React.useState<'all' | 'pending' | 'verified' | 'rejected'>('all');
  const [selectedUid, setSelectedUid] = React.useState<string | null>(
    MOCK_RESPONDERS.find((r) => r.verification === 'pending')?.uid ?? null,
  );
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const [decision, setDecision] = React.useState<'approve' | 'reject' | null>(null);

  const list = React.useMemo(
    () => (filter === 'all' ? MOCK_RESPONDERS : MOCK_RESPONDERS.filter((r) => r.verification === filter)),
    [filter],
  );
  const selected = MOCK_RESPONDERS.find((r) => r.uid === selectedUid) ?? null;
  const reasonTooShort = reason.trim().length < REPORT_LIMITS.reasonMinChars;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Responder verification"
        description="Approving makes a responder assignable to incidents. Verification is a separate capability from a role change, so this page has no role controls at all."
        meta={<DemoDataBadge />}
      />

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="pt-4">
            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by verification status">
              {(['all', 'pending', 'verified', 'rejected'] as const).map((value) => (
                <Button
                  key={value}
                  variant={filter === value ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {value === 'all' ? 'All' : value === 'pending' ? 'Pending' : value === 'verified' ? 'Verified' : 'Rejected'}
                </Button>
              ))}
            </div>

            {list.length === 0 ? (
              <EmptyState
                icon={UserCheck}
                title={EMPTY_COPY.verifications.title}
                description={EMPTY_COPY.verifications.description}
              />
            ) : (
              <ul aria-label="Responder verification queue" className="flex flex-col divide-y divide-subtle">
                {list.map((responder) => (
                  <li key={responder.uid}>
                    <button
                      type="button"
                      onClick={() => setSelectedUid(responder.uid)}
                      aria-current={responder.uid === selectedUid ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-3 py-2.5 pl-2 pr-1 text-left transition-colors',
                        'rounded-sm focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus',
                        responder.uid === selectedUid ? 'bg-elevated' : 'hover:bg-elevated',
                      )}
                    >
                      <Avatar name={responder.displayName} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-primary">
                          {responder.displayName}
                        </span>
                        <span className="block text-xs text-secondary">
                          {responder.verification === 'pending'
                            ? 'Awaiting review'
                            : responder.verification === 'verified'
                              ? 'Verified and assignable'
                              : responder.verification}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selected ? (
          <Card>
            <CardContent className="flex flex-col gap-5 pt-4">
              <div className="flex items-center gap-3">
                <Avatar name={selected.displayName} size="xl" />
                <div>
                  <h2 className="text-xl font-semibold text-primary">{selected.displayName}</h2>
                  <p className="text-sm text-secondary">
                    Submitted {formatDate(selected.submittedAt)}
                  </p>
                </div>
              </div>

              <section>
                <h3 className="uppercase-label mb-2 text-muted">Declared capabilities</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {selected.capabilities.length === 0 ? (
                    <li className="text-sm text-secondary">None declared</li>
                  ) : (
                    selected.capabilities.map((capability) => (
                      <li
                        key={capability}
                        className="rounded-pill border border-default bg-elevated px-2.5 py-1 text-xs text-primary"
                      >
                        {capability.replace('res_', '').replace(/_/g, ' ')}
                      </li>
                    ))
                  )}
                </ul>
              </section>

              <section>
                <h3 className="uppercase-label mb-2 text-muted">Certifications</h3>
                {selected.certifications.length === 0 ? (
                  <p className="text-sm text-secondary">No certifications supplied</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {selected.certifications.map((cert) => (
                      <li key={cert.name} className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-primary">{cert.name}</span>
                        <span className="text-xs text-secondary">
                          {cert.expiresAt ? `expires ${formatDate(cert.expiresAt)}` : 'no expiry recorded'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <Textarea
                label="Reason"
                required
                rows={3}
                maxChars={REPORT_LIMITS.reasonMaxChars}
                showCount
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setTouched(true)}
                errorMessage={
                  touched && reasonTooShort
                    ? `Write at least ${REPORT_LIMITS.reasonMinChars} characters. This is recorded with your name.`
                    : undefined
                }
                helperText="Recorded in the audit log with your name against the decision."
              />

              {selected.verification === 'verified' ? (
                <Alert tone="info">
                  <AlertTitle>This responder is already verified</AlertTitle>
                  <AlertDescription>They are already assignable to incidents.</AlertDescription>
                </Alert>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="primary" className="min-h-12" onClick={() => setDecision('approve')}>
                    Approve responder
                  </Button>
                  <Button variant="danger-outline" className="min-h-12" onClick={() => setDecision('reject')}>
                    Reject
                  </Button>
                </div>
              )}

              <Alert tone="neutral">
                <AlertTitle>What is recorded</AlertTitle>
                <AlertDescription>
                  Approving {selected.displayName} makes them assignable to incidents. Your name and
                  this reason are written to the audit log.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={UserCheck}
            title="Select a responder"
            description="Choose someone from the queue to review their certifications and decide."
          />
        )}
      </div>

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDecision(null);
            setReason('');
            setTouched(false);
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {decision === 'approve' ? 'Approve this responder' : 'Reject this responder'}
            </DialogTitle>
            <DialogDescription>
              {decision === 'approve'
                ? `Approving makes ${selected?.displayName ?? 'this responder'} assignable to incidents. Your name and this reason are recorded in the audit log.`
                : `Rejecting removes ${selected?.displayName ?? 'this responder'} from the candidate list. They are notified. Your name and this reason are recorded.`}
            </DialogDescription>
          </DialogHeader>

          {reasonTooShort ? (
            <Alert tone="danger" role="alert">
              <AlertTitle>A reason is required</AlertTitle>
              <AlertDescription>
                Write at least {REPORT_LIMITS.reasonMinChars} characters before confirming.
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button
              variant={decision === 'approve' ? 'primary' : 'danger'}
              disabled={reasonTooShort}
              onClick={() => {
                toast(decision === 'approve' ? 'Responder approved' : 'Responder rejected', {
                  description: 'Phase 1 shell: nothing was sent. A real decision writes an audit entry and notifies the responder.',
                });
                setDecision(null);
                setReason('');
                setTouched(false);
              }}
            >
              {decision === 'approve' ? 'Approve and record' : 'Reject and record'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ========================================================================== */
/* /admin/audit-logs — docs/04 §13.21                                         */
/* ========================================================================== */

export function AdminAuditLogsView() {
  const [actor, setActor] = React.useState('');
  const [action, setAction] = React.useState<'all' | (typeof AUDIT_ACTIONS)[number]>('all');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [selected, setSelected] = React.useState<AuditEntry | null>(null);

  const pageSize = 50;

  const filtered = React.useMemo(() => {
    const a = actor.trim().toLowerCase();
    return MOCK_AUDIT_ENTRIES.filter((entry) => {
      if (action !== 'all' && entry.action !== action) return false;
      if (a && !entry.actor.displayName.toLowerCase().includes(a) && !entry.actor.uid.toLowerCase().includes(a)) {
        return false;
      }
      if (from && entry.createdAt < new Date(from).toISOString()) return false;
      if (to && entry.createdAt > new Date(`${to}T23:59:59Z`).toISOString()) return false;
      return true;
    });
  }, [actor, action, from, to]);

  const paged = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        description="Every privileged action, append-only. This page is read-only for every role that can reach it — there is no edit, no delete, and no clear affordance anywhere."
        meta={<DemoDataBadge />}
        actions={[{ label: 'Export CSV', variant: 'outline', icon: ScrollText }]}
      />

      <Alert tone="neutral">
        <AlertTitle>Append-only</AlertTitle>
        <AlertDescription>
          No role, including administrator, can change or remove an audit entry. Entries are
          retained for 365 days.
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-4">
          <Input
            label="Actor"
            value={actor}
            onChange={(e) => { setActor(e.target.value); setPage(0); }}
            placeholder="Name or uid"
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary">Action</span>
            <Select value={action} onValueChange={(v) => { setAction(v as typeof action); setPage(0); }}>
              <SelectTrigger>
                <SelectValue placeholder="Any action" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">Any action</SelectItem>
                {AUDIT_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    <code className="font-mono text-xs">{a}</code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            label="From"
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(0); }}
          />
          <Input
            label="To"
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(0); }}
          />
        </CardContent>
      </Card>

      {paged.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={EMPTY_COPY.audit.title}
          description={EMPTY_COPY.audit.description}
          action={{
            label: EMPTY_COPY.audit.actionLabel,
            onClick: () => { setActor(''); setAction('all'); setFrom(''); setTo(''); setPage(0); },
          }}
        />
      ) : (
        <div className="rounded-card border border-default bg-surface">
          <Table>
            <TableCaption className="sr-only">
              Audit log. {filtered.length} entries match the current filters. Entries are
              append-only and retained for 365 days.
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">When</TableHead>
                <TableHead scope="col">Actor</TableHead>
                <TableHead scope="col">Action</TableHead>
                <TableHead scope="col">Entity</TableHead>
                <TableHead scope="col">Reason</TableHead>
                <TableHead scope="col">Request</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((entry) => (
                <TableRow
                  key={entry.logId}
                  data-state={selected?.logId === entry.logId ? 'selected' : undefined}
                >
                  <TableCell className="whitespace-nowrap font-mono text-2xs tabular">
                    {formatAuditStamp(entry.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Avatar name={entry.actor.displayName} size="xs" />
                      <span className="clamp-1 text-sm">{entry.actor.displayName}</span>
                      <RoleBadge role={entry.actor.role} size="sm" />
                    </span>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-secondary">{entry.action}</code>
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="text-xs text-secondary">{entry.entityType}</span>
                      <code className="font-mono text-2xs text-muted">
                        {entry.incidentRef ?? entry.entityId}
                      </code>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="clamp-1 text-xs">{entry.reason ?? '—'}</span>
                  </TableCell>
                  <TableCell>
                    <RequestId value={entry.requestId} />
                    <span className="sr-only">
                      {entry.hasIpHash ? ' An IP hash was recorded.' : ' No IP hash was recorded.'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pagination
        rowLabel={`Rows ${paged.length === 0 ? 0 : page * pageSize + 1}–${page * pageSize + paged.length} of ${filtered.length}`}
        hasPrevious={page > 0}
        hasNext={page + 1 < totalPages}
        onPrevious={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
      />

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="w-full sm:max-w-[520px] p-0">
          <SheetHeader>
            <SheetTitle>Audit entry</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {selected ? (
              <div className="flex flex-col gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-secondary">When</dt>
                  <dd>{formatAbsolute(selected.createdAt)}</dd>
                  <dt className="text-secondary">Actor</dt>
                  <dd>
                    {selected.actor.displayName} <RoleBadge role={selected.actor.role} size="sm" />
                  </dd>
                  <dt className="text-secondary">Action</dt>
                  <dd><code className="font-mono text-xs">{selected.action}</code></dd>
                  <dt className="text-secondary">Entity</dt>
                  <dd>
                    {selected.entityType} <code className="font-mono text-2xs">{selected.entityId}</code>
                  </dd>
                  <dt className="text-secondary">Reason</dt>
                  <dd>{selected.reason ?? '—'}</dd>
                  <dt className="text-secondary">Request</dt>
                  <dd><RequestId value={selected.requestId} /></dd>
                </dl>

                <div className="grid gap-3 sm:grid-cols-2">
                  <DiffBlock label="Value before" value={selected.before} />
                  <DiffBlock label="Value after" value={selected.after} />
                </div>
              </div>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The before/after diff. Never colour-only: each block is labelled in text. */
function DiffBlock({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  return (
    <div className="rounded-card border border-default bg-inset p-3">
      <p className="uppercase-label mb-2 text-muted">{label}</p>
      {value === null ? (
        <p className="text-xs text-muted">Not recorded</p>
      ) : (
        <dl className="flex flex-col gap-1">
          {Object.entries(value).map(([key, v]) => (
            <div key={key} className="flex items-baseline justify-between gap-2">
              <dt className="font-mono text-2xs text-muted">{key}</dt>
              <dd className="font-mono text-2xs text-secondary">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* ========================================================================== */
/* /admin/settings — the platform tunables (docs/04 §16 D14)                 */
/* ========================================================================== */

export function AdminSettingsView() {
  const [radius, setRadius] = React.useState(500);
  const [windowMin, setWindowMin] = React.useState(360);
  const [threshold, setThreshold] = React.useState(0.6);
  const [criticalSla, setCriticalSla] = React.useState(5);
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  const radiusInvalid = radius < 100 || radius > 2000;
  const windowInvalid = windowMin < 60 || windowMin > 4320;
  const thresholdInvalid = threshold < 0.2 || threshold > 0.9;
  const slaInvalid = criticalSla < 1 || criticalSla > 60;
  const reasonTooShort = reason.trim().length < REPORT_LIMITS.reasonMinChars;
  const anyInvalid = radiusInvalid || windowInvalid || thresholdInvalid || slaInvalid;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platform settings"
        description="Tunables that change how the system behaves. Every change is recorded with the previous and new value."
        meta={<DemoDataBadge />}
      />

      <Alert tone="warning">
        <AlertTitle>Changes affect new incidents immediately</AlertTitle>
        <AlertDescription>
          A threshold change is applied to the next duplicate check. Incidents already created keep
          the values they were triaged with, because rewriting history would break the audit trail.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-4">
            <h2 className="text-lg font-semibold text-primary">Duplicate detection</h2>
            <Input
              label="Duplicate radius (m)"
              type="number"
              min={100}
              max={2000}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              onBlur={() => setTouched(true)}
              errorMessage={touched && radiusInvalid ? 'Enter a value between 100 and 2000 metres.' : undefined}
              helperText="Candidate generation only. Proximity never merges on its own."
            />
            <Input
              label="Time window (minutes)"
              type="number"
              min={60}
              max={4320}
              value={windowMin}
              onChange={(e) => setWindowMin(Number(e.target.value))}
              onBlur={() => setTouched(true)}
              errorMessage={touched && windowInvalid ? 'Enter a value between 60 and 4320 minutes.' : undefined}
              helperText="Reports further apart in time are never considered duplicates."
            />
            <Input
              label="Text similarity threshold"
              type="number"
              min={0.2}
              max={0.9}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              onBlur={() => setTouched(true)}
              errorMessage={touched && thresholdInvalid ? 'Enter a value between 0.2 and 0.9.' : undefined}
              helperText="Above this, a same-category nearby report is suggested as a duplicate."
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4 pt-4">
            <h2 className="text-lg font-semibold text-primary">Response targets</h2>
            <Input
              label="Critical target (minutes)"
              type="number"
              min={1}
              max={60}
              value={criticalSla}
              onChange={(e) => setCriticalSla(Number(e.target.value))}
              onBlur={() => setTouched(true)}
              errorMessage={touched && slaInvalid ? 'Enter a value between 1 and 60 minutes.' : undefined}
              helperText="Changing a target does not clear an incident that has already breached it."
            />

            <div className="rounded-card border border-default bg-inset p-3">
              <p className="uppercase-label mb-2 text-muted">Other targets, unchanged</p>
              <dl className="grid grid-cols-3 gap-2 text-sm">
                {(['high', 'medium', 'low'] as const).map((urgency) => (
                  <React.Fragment key={urgency}>
                    <dt className="capitalize text-secondary">{urgency}</dt>
                    <dd className="col-span-2 text-right tabular text-primary">
                      {urgency === 'high' ? 15 : urgency === 'medium' ? 60 : 240} min
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>

            <div>
              <p className="text-sm font-medium text-secondary">Category taxonomy</p>
              <p className="mt-1 text-xs text-secondary">
                {CATEGORY_LIST.length} controlled categories. Adding one is a code change and a
                documentation amendment, not a setting.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {CATEGORY_LIST.map((c) => (
                  <li
                    key={c}
                    className="rounded-pill border border-default bg-elevated px-2 py-0.5 text-2xs text-secondary"
                  >
                    {CATEGORY_META[c].label}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-4">
          <h2 className="text-lg font-semibold text-primary">Record this change</h2>
          <Textarea
            label="Reason"
            required
            rows={3}
            maxChars={REPORT_LIMITS.reasonMaxChars}
            showCount
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            errorMessage={
              touched && reasonTooShort
                ? `Write at least ${REPORT_LIMITS.reasonMinChars} characters.`
                : undefined
            }
            helperText="Recorded with the previous and new values in the audit log."
          />

          {touched && (reasonTooShort || anyInvalid) ? (
            <Alert tone="danger" role="alert">
              <AlertTitle>Check these before saving</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc">
                  {reasonTooShort ? <li>A reason of at least {REPORT_LIMITS.reasonMinChars} characters is required.</li> : null}
                  {radiusInvalid ? <li>The duplicate radius must be between 100 and 2000 metres.</li> : null}
                  {windowInvalid ? <li>The time window must be between 60 and 4320 minutes.</li> : null}
                  {thresholdInvalid ? <li>The similarity threshold must be between 0.2 and 0.9.</li> : null}
                  {slaInvalid ? <li>The critical target must be between 1 and 60 minutes.</li> : null}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          <div>
            <Button
              variant="primary"
              disabled={reasonTooShort || anyInvalid}
              title={
                reasonTooShort
                  ? 'A reason is required'
                  : anyInvalid
                    ? 'One or more values are outside the allowed range'
                    : undefined
              }
              onClick={() => {
                toast('Settings change recorded', {
                  description:
                    'Phase 1 shell: nothing was sent. A real save writes the previous and new values to the audit log.',
                });
                setReason('');
                setTouched(false);
              }}
            >
              Save and record the change
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { ShieldQuestion, RelativeTime, CATEGORY_LIST, MOCK_CURRENT_USER_UID };
