/**
 * `services/incidents` barrel. `docs/17 §1.1`: one import path per concern.
 *
 * The create path is the only export for now. `services/dispatch` owns the
 * lifecycle transitions and `services/geo` owns duplicate detection, so those are
 * re-exported from their own barrels rather than from here — a caller that needs
 * to transition an incident imports `@/services/dispatch`, not this file.
 */

export {
  createIncident,
  type CreateIncidentInput,
  type CreateIncidentLocation,
  type CreateIncidentResult,
} from '@/services/incidents/create';

export {
  getIncident,
  listIncidents,
  readScopeFor,
  scopeFor,
  type GetIncidentResult,
  type IncidentRow,
  type IncidentScopeComponent,
  type IncidentScopeReport,
  type ListIncidentsQuery,
  type ListIncidentsResult,
} from '@/services/incidents/read';