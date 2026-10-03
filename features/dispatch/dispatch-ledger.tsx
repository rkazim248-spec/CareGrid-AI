'use client';

import { PageHeader } from '@/components/layout';
import { LiveDataUnavailable } from '@/components/feedback';
import { useResolvedSession } from '@/components/providers/session-provider';
import { ResponderAssignmentList } from '@/features/dispatch/responder-assignment-list';

/**
 * DispatchLedger — `/dispatches` (docs/04 §13.12).
 *
 * Responders see real assignments scoped to their account. The dispatcher
 * ledger has no list endpoint yet, so that role gets an explicit unavailable
 * state instead of sample dispatches.
 *
 * The word "dispatch" here means only "assigning a community responder"
 * (docs/04 §15.4). Nothing on this screen implies an ambulance, a police unit, or
 * any public service, and there is no claim of a partnership with one.
 */

export function DispatchLedger() {
  const { role } = useResolvedSession();
  if (role !== 'responder') {
    return (
      <LiveDataUnavailable
        title="Dispatches"
        description="The dispatcher assignment ledger is not connected to live dispatch records."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="My assignments"
        description="Live dispatches addressed to you. Answer here, or from the alert when one arrives."
      />
      <ResponderAssignmentList />
    </div>
  );
}
