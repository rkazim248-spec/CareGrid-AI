import type { Metadata } from 'next';

import { IncidentDetailRecord } from '@/features/incidents/incident-detail-record';

export const metadata: Metadata = {
  title: 'Incident details',
  description: 'Review the saved report, analysis, location, and uploaded evidence.',
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IncidentDetailRecord incidentId={id} />;
}
