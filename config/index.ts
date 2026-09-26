/**
 * Public barrel for the static configuration tables.
 *
 * docs/31_CODING_STANDARDS.md: import configuration from `@/config`, never
 * from the individual module. That way a table can be reorganised without
 * touching every consumer, and it makes the "static data" surface greppable.
 */

export { CATEGORY_META, CATEGORY_LIST, categoryLabel } from './categories';
export type { CategoryMeta, CategorySimilarityGroup } from './categories';

export { STATUS_META, isTerminal, CITIZEN_PROGRESS_STEPS } from './statuses';
export type { StatusMeta } from './statuses';

export { URGENCY_META, SLA_MINUTES, URGENCY_FLOOR_FLAGS, urgencyRank } from './urgencies';
export type { UrgencyMeta } from './urgencies';

export { SAFETY_FLAG_META } from './safety-flags';
export type { SafetyFlagMeta } from './safety-flags';

export { ROLE_META, ROLE_ORDER, roleLabel, SELF_ROLE_CHANGE_REASON } from './roles';
export type { RoleMeta } from './roles';

export {
  NAV_BY_ROLE,
  BOTTOM_NAV_ITEMS,
  routeAllows,
  rolesForRoute,
} from './nav';
export type { NavGroup, NavItem } from './nav';

export {
  REPORT_LIMITS,
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_AUDIO_TYPES,
  ACCURACY_THRESHOLDS,
  DUPLICATE_DEFAULTS,
  CONFIDENCE_THRESHOLDS,
  MAX_REALTIME_LISTENERS,
} from './limits';

export { RESOURCE_CATALOGUE, resourceName, resourceNames } from './resources';
