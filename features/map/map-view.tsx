'use client';

import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';
import { PageHeader } from '@/components/layout';
import { LiveIncidentMap } from '@/features/map/live-incident-map';

export function MapView() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Map"
        description="Explore incident locations available to your account and open an incident record."
      />

      <Alert tone="neutral">
        <AlertIcon tone="neutral" />
        <div className="flex min-w-0 flex-col gap-1">
          <AlertTitle>Only authorized incident data is shown</AlertTitle>
          <AlertDescription>
            Map markers use saved coordinates from incidents your account can access. Reports without
            coordinates are kept in the list and are never assigned guessed locations.
          </AlertDescription>
        </div>
      </Alert>

      <LiveIncidentMap />
    </div>
  );
}
