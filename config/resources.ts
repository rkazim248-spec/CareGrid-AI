/**
 * Local mirror of the resource catalogue — docs/07 §11.1
 *
 * The server owns this data. The local mirror exists so a dropdown can render
 * a readable label for a `resourceId` without a round trip, which matters
 * because a responder on a bad connection must still be able to read what an
 * assignment requires (docs/04 §12.2).
 */

import type { ResourceItem } from '@/types/domain';

export const RESOURCE_CATALOGUE: readonly ResourceItem[] = [
  {
    resourceId: 'res_ambulance',
    name: 'Ambulance',
    category: 'medical',
    unit: 'vehicle',
    active: true,
  },
  {
    resourceId: 'res_first_aid',
    name: 'First-aid team',
    category: 'medical',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_fire_engine',
    name: 'Fire engine',
    category: 'fire',
    unit: 'vehicle',
    active: true,
  },
  {
    resourceId: 'res_fire_extinguisher_team',
    name: 'Fire extinguisher team',
    category: 'fire',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_police_support',
    name: 'Traffic support',
    category: 'traffic',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_traffic_control',
    name: 'Traffic control',
    category: 'traffic',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_heavy_tow',
    name: 'Heavy recovery tow',
    category: 'traffic',
    unit: 'vehicle',
    active: true,
  },
  {
    resourceId: 'res_water_rescue',
    name: 'Water rescue',
    category: 'rescue',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_search_team',
    name: 'Search team',
    category: 'rescue',
    unit: 'person',
    active: true,
  },
  {
    resourceId: 'res_cooling_shelter',
    name: 'Cooling shelter',
    category: 'shelter',
    unit: 'person_shift',
    active: true,
  },
  {
    resourceId: 'res_food_water_kit',
    name: 'Food and water kit',
    category: 'logistics',
    unit: 'kit',
    active: true,
  },
  {
    resourceId: 'res_power_team',
    name: 'Power restoration team',
    category: 'utility',
    unit: 'person',
    active: true,
  },
];

const BY_ID = new Map(RESOURCE_CATALOGUE.map((r) => [r.resourceId, r]));

/** Never return undefined to a component — fall back to the raw id. */
export function resourceName(resourceId: string): string {
  return BY_ID.get(resourceId)?.name ?? resourceId;
}

export function resourceNames(resourceIds: readonly string[]): string[] {
  return resourceIds.map(resourceName);
}
