import type { Metadata } from 'next';

import { DispatchLedger } from '@/features/dispatch/dispatch-ledger';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/dispatches` — the dispatcher's assignment ledger and the responder's own
 * assignment list (docs/04 §13.12).
 *
 * A citizen is refused IN PLACE by `RoleGate` (docs/04 §13.22). The ledger reads
 * the session role and scopes itself: a responder sees only their own rows.
 */
export const metadata: Metadata = {
  title: 'Dispatches',
  description:
    'Community responder assignment history and status.',
};

export default function Page() {
  return (
    <RoleGate href="/dispatches">
      <DispatchLedger />
    </RoleGate>
  );
}
