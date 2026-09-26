/**
 * Shared formatting barrel. Components import from `@/lib/format`, never from
 * an individual module, so a formatter can change representation without a
 * fifty-file sweep. docs/31_CODING_STANDARDS.md §"Utilities".
 */

export {
  APP_TIMEZONE,
  TIMEZONE_LABEL,
  DEMO_NOW,
  formatClock,
  formatAbsolute,
  formatDate,
  formatAuditStamp,
  formatRelative,
  relativeTimeAriaLabel,
  formatDayHeading,
  toDateTimeAttr,
} from './time';

export {
  formatDistance,
  distanceAriaLabel,
  formatDuration,
  formatSlaRemaining,
  formatConfidence,
  formatPercent,
  formatBytes,
  formatCount,
  formatCountdown,
  formatAge,
  formatAccuracy,
} from './numbers';

export { haversineM, projectToPercent, clampPercent, DEMO_CENTER, DEMO_SPAN_M } from './geo';
