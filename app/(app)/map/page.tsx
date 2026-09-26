import type { Metadata } from 'next';

import { MapView } from '@/features/map/map-view';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/map` — live incident map with a full list equivalent (docs/04 §13.10).
 *
 * A citizen is refused IN PLACE by `RoleGate`. A responder may open this route;
 * from Phase 3 the server scopes their view to in-radius unassigned incidents
 * plus their own assignments. In Phase 1 the scope is the shared mock set and
 * the view states plainly that the figures are demo data.
 */
export const metadata: Metadata = {
  title: 'Map',
  description:
    'Active incidents as a map and as a list, with the 500 m duplicate zone. Demo data only.',
};

export default function Page() {
  return (
    <RoleGate href="/map">
      <MapView />
    </RoleGate>
  );
}
