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

/**
 * The 12 ids, as a tuple, DERIVED from the catalogue above.
 *
 * Added for Phase 4. `services/ai/schema.ts` needs the ids as a closed set so
 * the AI output schema can constrain `required_resources[].resourceId` to a
 * real catalogue entry, and a hand-copied list of 12 strings is exactly the kind
 * of duplication that lets a resource be requested that cannot be dispatched.
 *
 * Derived rather than written, so adding a 13th resource to the catalogue
 * widens the enum automatically. `tests/unit/config-invariants.test.ts` asserts
 * the length and the uniqueness, because a derived list is only trustworthy if
 * something checks that the derivation did what it was supposed to.
 */
export const RESOURCE_IDS = RESOURCE_CATALOGUE.map((r) => r.resourceId).sort() as [
  (typeof RESOURCE_CATALOGUE)[number]['resourceId'],
  ...(typeof RESOURCE_CATALOGUE)[number]['resourceId'][],
];

/** Never return undefined to a component — fall back to the raw id. */
export function resourceName(resourceId: string): string {
  return BY_ID.get(resourceId)?.name ?? resourceId;
}

export function resourceNames(resourceIds: readonly string[]): string[] {
  return resourceIds.map(resourceName);
}
