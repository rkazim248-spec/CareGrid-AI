import type { Metadata } from 'next';

import { ResponderDirectory } from '@/features/responders/responder-directory';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/responders` — the roster for dispatchers and admins, and the responder's own
 * availability and capability profile when a responder signs in
 * (docs/04 §13.11).
 *
 * A citizen is refused IN PLACE by `RoleGate` (docs/04 §13.22). The variant
 * inside the page is chosen by the session role, not by the viewport.
 */
export const metadata: Metadata = {
  title: 'Responders',
  description:
    'Community responder availability, verification, capabilities, and service radius. Demo data only.',
};

export default function Page() {
  return (
    <RoleGate href="/responders">
      <ResponderDirectory />
    </RoleGate>
  );
}
