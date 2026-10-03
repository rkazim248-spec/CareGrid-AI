import type { Metadata } from 'next';

import { MapView } from '@/features/map/map-view';
import { RoleGate } from '@/features/shared/role-gate';

/**
 * `/map` — caller-scoped incident locations with an accessible incident list.
 *
 * A citizen is refused in place by `RoleGate`; the incident API applies its own
 * authorization scope before any location reaches the browser.
 */
export const metadata: Metadata = {
  title: 'Map',
  description:
    'Authorized saved incident locations and incident details.',
};

export default function Page() {
  return (
    <RoleGate href="/map">
      <MapView />
    </RoleGate>
  );
}
