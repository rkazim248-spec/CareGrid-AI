'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { UserCog, ShieldAlert, Ban, RotateCcw } from 'lucide-react';

import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SearchInput } from '@/components/ui/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Avatar } from '@/components/ui/avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DataTable } from '@/components/table';
import { TableCell, TableRow } from '@/components/ui/table';
import { RoleBadge } from '@/components/domain/role-badge';
import { AccountStatusBadge } from '@/features/profile/account-status-badge';
import { Timestamp } from '@/components/domain/timestamp';
import { DemoDataBadge, EmptyState, EMPTY_COPY } from '@/components/feedback';
import { ROLE_META, ROLE_ORDER, SELF_ROLE_CHANGE_REASON } from '@/config/roles';
import { MOCK_USERS, MOCK_CURRENT_USER_UID } from '@/lib/mock-data';
import { REPORT_LIMITS } from '@/config/limits';
import type { User } from '@/types/domain';
import type { UserRole } from '@/types/enums';

/**
 * /admin/users — docs/04 §13.18
 *
 * Two things here are non-negotiable and easy to get wrong:
 *
 * 1. **ROW 61 IS A HARD DENIAL.** An administrator may not change their OWN
 *    role or account status (docs/22 §3 rows 59 and 61). The control renders
 *    as DISABLED WITH A REASON on the signed-in admin's own row — not hidden.
 *    Hiding it would leave a reviewer unable to tell "correctly prevented" from
 *    "not implemented".
 *
 * 2. **ROLE CHANGE IS A TWO-STEP CONFIRM** (US-031 AC1): step 1 collects the
 *    new role and a reason ≥ 10 chars; step 2 names the user and both roles
 *    explicitly. The dialog states that the change is recorded.
 */
export function AdminUsersView() {
  const [query, setQuery] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState<'all' | UserRole>('all');
  const [statusFilter, setStatusFilter] = React.useState<'all' | 'active' | 'suspended' | 'pending_verification'>('all');
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(50);
  const [selectedUser, setSelectedUser] = React.useState<User | null>(null);
  const [roleDialog, setRoleDialog] = React.useState<{ user: User; step: 1 | 2; nextRole: UserRole; reason: string } | null>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return MOCK_USERS.filter((user) => {
      if (roleFilter !== 'all' && user.role !== roleFilter) return false;
      if (statusFilter !== 'all' && user.status !== statusFilter) return false;
      if (!q) return true;
      return (
        user.displayName.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q) ||
        user.uid.toLowerCase().includes(q)
      );
    });
  }, [query, roleFilter, statusFilter]);

  const paged = filtered.slice(page * pageSize, page * pageSize + pageSize);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  function openRoleDialog(user: User) {
    if (user.uid === MOCK_CURRENT_USER_UID || user.role === 'admin') return;
    setRoleDialog({ user, step: 1, nextRole: user.role, reason: '' });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Accounts, roles, and access state. Every change here is recorded with your name, the reason, and the previous and new role."
        meta={<DemoDataBadge />}
      />

      <Card>
        <CardContent className="grid gap-4 pt-4 md:grid-cols-4">
          <SearchInput
            label="Search users"
            value={query}
            onValueChange={(v) => {
              setQuery(v);
              setPage(0);
            }}
            onDebouncedChange={() => undefined}
            placeholder="Name, email, or uid"
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary">Role</span>
            <Select value={roleFilter} onValueChange={(v) => { setRoleFilter(v as 'all' | UserRole); setPage(0); }}>
              <SelectTrigger>
                <SelectValue placeholder="Any role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any role</SelectItem>
                {ROLE_ORDER.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_META[r].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-secondary">Status</span>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(0); }}>
              <SelectTrigger>
                <SelectValue placeholder="Any status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="pending_verification">Pending verification</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              variant="ghost"
              onClick={() => {
                setQuery('');
                setRoleFilter('all');
                setStatusFilter('all');
                setPage(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          icon={UserCog}
          title={EMPTY_COPY.users.title}
          description={EMPTY_COPY.users.description}
          action={{ label: EMPTY_COPY.users.actionLabel, onClick: () => { setQuery(''); setRoleFilter('all'); setStatusFilter('all'); } }}
        />
      ) : (
        <>
          <DataTable
            caption="Platform users with role and access state"
            headers={['uid', 'Name', 'Email', 'Role', 'Status', 'Last login', '']}
            rowLabel={`${filtered.length} users match the current filters`}
          >
            {paged.map((user) => {
              const isSelf = user.uid === MOCK_CURRENT_USER_UID;
              return (
                <TableRow key={user.uid} data-state={selectedUser?.uid === user.uid ? 'selected' : undefined}>
                  <TableCell>
                    <code className="font-mono text-2xs text-muted">{user.uid}</code>
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setSelectedUser(user)}
                      className="flex items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-[2px] focus-visible:ring-focus"
                    >
                      <Avatar name={user.displayName} size="xs" />
                      <span className="text-sm text-primary">
                        {user.displayName}
                        {isSelf ? (
                          <span className="ml-1 text-xs text-muted">(you)</span>
                        ) : null}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    <span className="clamp-1">{user.email}</span>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={user.role} />
                  </TableCell>
                  <TableCell>
                    <AccountStatusBadge status={user.status} />
                  </TableCell>
                  <TableCell>
                    <Timestamp iso={user.lastLoginAt} showDate={false} />
                  </TableCell>
                  <TableCell>
                    {isSelf ? (
                      <span className="flex items-center gap-1.5 text-xs text-warning">
                        <ShieldAlert className="size-3.5" aria-hidden="true" />
                        {SELF_ROLE_CHANGE_REASON}
                      </span>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => openRoleDialog(user)}>
                        Change role
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>

          <Pagination
            rowLabel={`Rows ${paged.length === 0 ? 0 : page * pageSize + 1}–${page * pageSize + paged.length} of ${filtered.length}`}
            hasPrevious={page > 0}
            hasNext={page + 1 < totalPages}
            onPrevious={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            pageSize={pageSize}
            onPageSizeChange={(size) => { setPageSize(size); setPage(0); }}
            pageSizeOptions={[REPORT_LIMITS.defaultPageSize, 50, REPORT_LIMITS.maxPageSize]}
          />
        </>
      )}

      {/* User detail sheet */}
      <Sheet open={Boolean(selectedUser)} onOpenChange={(open) => !open && setSelectedUser(null)}>
        <SheetContent side="right" className="p-0">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              {selectedUser ? <Avatar name={selectedUser.displayName} size="lg" /> : null}
              {selectedUser?.displayName}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            {selectedUser ? (
              <div className="flex flex-col gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-secondary">uid</dt>
                  <dd><code className="font-mono text-2xs">{selectedUser.uid}</code></dd>
                  <dt className="text-secondary">Email</dt>
                  <dd className="clamp-1">{selectedUser.email}</dd>
                  <dt className="text-secondary">Role</dt>
                  <dd><RoleBadge role={selectedUser.role} /></dd>
                  <dt className="text-secondary">Status</dt>
                  <dd><AccountStatusBadge status={selectedUser.status} /></dd>
                  <dt className="text-secondary">Provider</dt>
                  <dd>{selectedUser.provider}</dd>
                  <dt className="text-secondary">Created</dt>
                  <dd><Timestamp iso={selectedUser.createdAt} /></dd>
                  <dt className="text-secondary">Last login</dt>
                  <dd><Timestamp iso={selectedUser.lastLoginAt} /></dd>
                </dl>

                <Alert tone="neutral">
                  <AlertTitle>Recent activity</AlertTitle>
                  <AlertDescription>
                    The full audit trail for this user is available on the audit log page, filtered
                    by their uid.
                  </AlertDescription>
                </Alert>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/admin/audit-logs?actorUid=${selectedUser.uid}`}>View audit trail</a>
                  </Button>
                  <Button
                    variant="danger-outline"
                    size="sm"
                    disabled={selectedUser.uid === MOCK_CURRENT_USER_UID}
                    title={
                      selectedUser.uid === MOCK_CURRENT_USER_UID
                        ? SELF_ROLE_CHANGE_REASON
                        : 'Requires a reason, recorded in the audit log'
                    }
                  >
                    <Ban className="size-3.5" aria-hidden="true" />
                    Suspend
                  </Button>
                  <Button variant="ghost" size="sm" title="Requires a reason">
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    Reset claims
                  </Button>
                </div>
              </div>
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>

      {/* Two-step role change */}
      <RoleChangeDialog
        state={roleDialog}
        onClose={() => setRoleDialog(null)}
        onStep1={(nextRole, reason) => setRoleDialog((s) => (s ? { ...s, step: 2, nextRole, reason } : s))}
        onBack={() => setRoleDialog((s) => (s ? { ...s, step: 1 } : s))}
        onConfirm={(user) => {
          toast('Role change recorded', {
            description: `${user.displayName} is now ${ROLE_META[roleDialog?.nextRole ?? 'citizen'].label}. Nothing was sent — this is the Phase 1 UI shell.`,
          });
          setRoleDialog(null);
        }}
      />
    </div>
  );
}

function RoleChangeDialog({
  state,
  onClose,
  onStep1,
  onBack,
  onConfirm,
}: {
  state: { user: User; step: 1 | 2; nextRole: UserRole; reason: string } | null;
  onClose: () => void;
  onStep1: (role: UserRole, reason: string) => void;
  onBack: () => void;
  onConfirm: (user: User) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [nextRole, setNextRole] = React.useState<UserRole>('citizen');
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (state) {
      setReason(state.reason);
      setNextRole(state.nextRole);
      setTouched(false);
    }
  }, [state]);

  if (!state) return null;
  const { user, step } = state;
  const reasonTooShort = reason.trim().length < REPORT_LIMITS.reasonMinChars;
  const unchanged = nextRole === user.role;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>Change role — step 1 of 2</DialogTitle>
              <DialogDescription>
                Choose the new role and record why. A reason of at least{' '}
                {REPORT_LIMITS.reasonMinChars} characters is required.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-secondary">New role</span>
                <Select value={nextRole} onValueChange={(v) => setNextRole(v as UserRole)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_ORDER.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_META[r].label} — {ROLE_META[r].blurb}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Textarea
                label="Reason"
                required
                rows={3}
                maxChars={REPORT_LIMITS.reasonMaxChars}
                showCount
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => setTouched(true)}
                errorMessage={touched && reasonTooShort ? `Write at least ${REPORT_LIMITS.reasonMinChars} characters so the change is understandable later.` : undefined}
                helperText="This is written to the audit log verbatim."
              />

              <Alert tone="neutral">
                <AlertTitle>What will be recorded</AlertTitle>
                <AlertDescription>
                  Your name, this reason, the previous role ({ROLE_META[user.role].label}), and the
                  new role. The audit entry is append-only.
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={reasonTooShort || unchanged}
                title={
                  unchanged
                    ? 'That user already has this role'
                    : reasonTooShort
                      ? 'A reason is required'
                      : undefined
                }
                onClick={() => onStep1(nextRole, reason)}
              >
                Continue to confirmation
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Confirm the role change</DialogTitle>
              <DialogDescription>
                This is recorded in the audit log with your name, the reason, and the previous and
                new role.
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-card border border-default bg-inset p-4">
              <p className="text-lg font-semibold text-primary">{user.displayName}</p>
              <p className="text-sm text-secondary">{user.email}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <RoleBadge role={user.role} size="md" />
                <span aria-hidden="true" className="text-muted">
                  becomes
                </span>
                <RoleBadge role={nextRole} size="md" />
              </div>
              <p className="mt-3 text-xs text-secondary">
                <span className="uppercase-label mr-1.5 text-muted">Reason</span>
                {reason}
              </p>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
              <Button variant="primary" onClick={() => onConfirm(user)}>
                Change role and record it
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
