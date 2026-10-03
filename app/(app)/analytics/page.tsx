import type { Metadata } from 'next';

import { AnalyticsView } from '@/features/analytics/analytics-view';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/analytics` — operational metrics for a period (docs/04 §13.13, FR-110…FR-118).
 *
 * `RoleGate` is the real permission boundary for this route: a responder or a
 * citizen gets the 403 state rendered IN PLACE, with the address bar left
 * truthful and no redirect loop (docs/04 §13.22, FR-117). `rolesForRoute` resolves
 * `/analytics` to `dispatcher | admin` from the same table the sidebar uses.
 */
export const metadata: Metadata = {
  title: 'Analytics',
  description:
    'Incident volume, category mix, response-time distribution, and risk zones from authorized operational data.',
};

export default function Page() {
  return (
    <RoleGate href="/analytics">
      <AnalyticsView />
    </RoleGate>
  );
}
