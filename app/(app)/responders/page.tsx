import type { Metadata } from 'next';

import { LiveDataUnavailable } from '@/components/feedback';
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
    'Responder availability and capabilities are unavailable until the live roster service is connected.',
};

export default function Page() {
  return (
    <RoleGate href="/responders">
      <LiveDataUnavailable
        title="Responder directory"
        description="Responder profiles and availability are not connected to a live roster yet."
      />
    </RoleGate>
  );
}
