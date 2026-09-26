import type { Metadata } from 'next';

import { RoleScopedIncidents } from '@/features/incidents/role-scoped-incidents';

/**
 * `/incidents` — one route, two audiences (docs/04 §13.8, §12.1).
 *
 * The spec is explicit that this is the ROLE-SCOPED archive and that a citizen
 * always sees only their own reports. So the view branches on the session role:
 *
 *   citizen → "My reports": their own filings and nothing else.
 *   responder / dispatcher / admin → the operations archive, with pagination,
 *   terminal statuses, the soft-deleted row, and the `Export CSV` permission
 *   boundary.
 *
 * The branch lives in a client component because Phase 1's session is a client
 * provider. From Phase 2 it moves into the RSC and the SERVER does the scoping —
 * the client branch is an affordance, never a boundary (docs/22 §6).
 */
export const metadata: Metadata = {
  title: 'Incidents',
  description: 'Incident records for your role, including closed and deleted reports.',
};

export default function Page() {
  return <RoleScopedIncidents />;
}
