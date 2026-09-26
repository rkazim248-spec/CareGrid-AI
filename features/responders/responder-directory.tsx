'use client';


import * as React from 'react';
import { Users } from 'lucide-react';

import {
  Badge,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SearchInput,
  SwitchField,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { PageHeader, SectionHeader } from '@/components/layout';
import { DemoDataBadge, EmptyState, EMPTY_COPY } from '@/components/feedback';
import { RESOURCE_CATALOGUE } from '@/config';
import { MOCK_RESPONDERS } from '@/lib/mock-data';
import type { Responder, ResponderStatus, VerificationStatus } from '@/types';
import { AvailabilityForm } from '@/features/responders/availability-form';
import { ResponderSheet } from '@/features/responders/responder-sheet';
import { RosterCards, RosterTable } from '@/features/responders/roster-table';
import { useResolvedSession } from '@/components/providers/session-provider';

/**
 * ResponderDirectory — `/responders` (docs/04 §13.11).
 *
 * One route, two audiences, chosen by ROLE and not by viewport:
 *
 *   dispatcher / admin → the roster: filters, a table at `md` and above, a card
 *     list below, and a `Sheet` with the full record on row activation. There is
 *     deliberately NO `/responders/[id]` route in v1 — the spec's own
 *     `DECISION REQUIRED` in §13.11 — so the Sheet is the detail view.
 *
 *   responder → their OWN record as a form. The API returns only their own
 *     record, so there is nothing to list, and rendering a list of colleagues
 *     would be a lie about the data.
 *
 * All five demo responders render, so the `offline`, `stale location`, and
 * `awaiting verification` states are visible on screen rather than described in
 * a paragraph somewhere.
 */

/** The demo responder's own record. `u_2Ww9Kz` first, else the first entry. */
const SELF_UID = 'u_2Ww9Kz';

export function selfResponder(): Responder | undefined {
  return MOCK_RESPONDERS.find((r) => r.uid === SELF_UID) ?? MOCK_RESPONDERS[0];
}

export function ResponderDirectory() {

  const { role } = useResolvedSession();
  if (role === 'responder') return <SelfProfile />;
  return <Roster />;
}

/* -------------------------------------------------------------------------- */
/* Responder: own profile                                                      */
/* -------------------------------------------------------------------------- */

function SelfProfile() {
  const self = selfResponder();

  if (!self) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Availability" />
        <EmptyState
          icon={Users}
          title={EMPTY_COPY.responders.title}
          description={EMPTY_COPY.responders.description}
        />
      </div>
    );
  }


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Availability"
        description="Your availability, what you can help with, how far you will travel, and how a dispatcher reaches you."
        meta={<DemoDataBadge />}
      />
      <SectionHeader
        title="Your responder record"
        description="Only you and an administrator can see all of this. A dispatcher sees your availability and location, not your phone number."
      />
      <AvailabilityForm self={self} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dispatcher / admin: the roster                                              */
/* -------------------------------------------------------------------------- */

type StatusTab = 'all' | ResponderStatus;

const STATUS_TABS: readonly StatusTab[] = ['all', 'available', 'busy', 'offline'];
const STATUS_TAB_LABEL: Record<StatusTab, string> = {
  all: 'All',
  available: 'Available',
  busy: 'Busy',
  offline: 'Offline',
};

const VERIFICATION_OPTIONS: readonly VerificationStatus[] = [
  'verified',
  'pending',
  'unverified',
  'rejected',
];

const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  verified: 'Verified',
  pending: 'Awaiting verification',
  unverified: 'Not verified',
  rejected: 'Verification rejected',
};

const STALE_HELPER = 'Last fix older than 15 minutes.';
const AVAILABILITY_TABS = 'Availability';

function Roster() {
  const [tab, setTab] = React.useState<StatusTab>('all');
  const [verification, setVerification] = React.useState('all');
  const [capability, setCapability] = React.useState('all');
  const [staleOnly, setStaleOnly] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [openUid, setOpenUid] = React.useState<string | null>(null);

  const id = React.useId();

  const rows = React.useMemo(
    () =>
      MOCK_RESPONDERS.filter((responder) => {
        if (tab !== 'all' && responder.status !== tab) return false;
        if (verification !== 'all' && responder.verification !== verification) return false;
        if (capability !== 'all' && !responder.capabilities.includes(capability)) return false;
        if (staleOnly && !responder.staleLocation) return false;
        const needle = q.trim().toLowerCase();
        if (needle && !responder.displayName.toLowerCase().includes(needle)) return false;
        return true;
      }),
    [tab, verification, capability, staleOnly, q],
  );

  const open = MOCK_RESPONDERS.find((r) => r.uid === openUid);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Responders"
        description="Community responders available in this area, what they can help with, and how fresh their location is."
        meta={<DemoDataBadge />}
      />

      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <SearchInput
              label="Search responders"
              value={q}
              onValueChange={setQ}
              containerClassName="w-full lg:w-[300px]"
            />

            <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor={`${id}-verification`} className="text-sm font-medium text-secondary">
                  Verification
                </label>
                <Select value={verification} onValueChange={setVerification}>
                  <SelectTrigger id={`${id}-verification`}>
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    {VERIFICATION_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {VERIFICATION_LABEL[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor={`${id}-capability`} className="text-sm font-medium text-secondary">
                  Capability
                </label>
                <Select value={capability} onValueChange={setCapability}>
                  <SelectTrigger id={`${id}-capability`}>
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any</SelectItem>
                    {RESOURCE_CATALOGUE.map((resource) => (
                      <SelectItem key={resource.resourceId} value={resource.resourceId}>
                        {resource.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-subtle pt-3 sm:flex-row sm:items-center">
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as StatusTab)}
              className="min-w-0"
            >
              <TabsList variant="pill" aria-label={AVAILABILITY_TABS}>
                {STATUS_TABS.map((value) => (
                  <TabsTrigger key={value} value={value} variant="pill">
                    {STATUS_TAB_LABEL[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="w-full rounded-control border border-subtle px-3 sm:w-[210px]">
              <SwitchField
                id={`${id}-stale`}
                label="Stale location only"
                helperText={STALE_HELPER}
                checked={staleOnly}
                onCheckedChange={setStaleOnly}
              />
            </div>

            <Badge variant="muted" size="sm" className="tabular" aria-live="polite">
              {rows.length} {rows.length === 1 ? 'responder' : 'responders'}
            </Badge>
          </div>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={EMPTY_COPY.responders.title}
          description={EMPTY_COPY.responders.description}
          action={{
            label: EMPTY_COPY.responders.actionLabel,
            onClick: () => {
              setTab('all');
              setVerification('all');
              setCapability('all');
              setStaleOnly(false);
              setQ('');
            },
          }}
        />
      ) : (
        <>
          <div className="hidden md:block">
            <RosterTable rows={rows} onOpen={setOpenUid} />
          </div>
          <div className="md:hidden">
            <RosterCards rows={rows} onOpen={setOpenUid} />
          </div>
        </>
      )}

      <ResponderSheet
        responder={open}
        onOpenChange={(next) => {
          if (!next) setOpenUid(null);
        }}
      />
    </div>
  );
}
