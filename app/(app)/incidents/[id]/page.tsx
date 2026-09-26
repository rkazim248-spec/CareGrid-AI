import type { Metadata } from 'next';

import { IncidentDetailView } from '@/features/incidents/incident-detail-view';
import { NotFoundState } from '@/components/feedback';
import { mockIncidentById } from '@/lib/mock-data';

/**
 * `/incidents/[id]` — the full operational record for one incident
 * (docs/04 §13.9).
 *
 * Next 15: `params` is a Promise and MUST be awaited. Anything else is a build
 * error in the App Router.
 *
 * US-005 AC4 — the important behaviour here is what happens for an unknown id.
 * A citizen following someone else's reference gets `NotFoundState`, whose copy
 * is byte-for-byte identical to a reference that does not exist. Differentiating
 * the two would turn this page into an existence oracle: anyone could probe
 * references to learn which incidents are real. It is NEVER a 403
 * (docs/04 §13.9, §9.3).
 *
 * No role gate here: `/incidents/:id` is reachable by all four roles, and
 * resource-level visibility is the SERVER's job from Phase 2 (docs/22 §4.1).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const incident = mockIncidentById(id);
  return {
    title: incident ? incident.reference : 'Incident not found',
    description: incident
      ? `${incident.reference} — full incident record. Demo data.`
      : 'We could not find that reference.',
  };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = mockIncidentById(id);

  if (!incident) {
    return <NotFoundState variant="reference" />;
  }

  return <IncidentDetailView incident={incident} />;
}
