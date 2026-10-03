import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';

export function DemoAvailabilityNotice() {
  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 pt-3 sm:px-6 lg:px-8">
      <Alert tone="info" role="status" className="rounded-control">
        <AlertIcon tone="info" />
        <div className="min-w-0">
          <AlertTitle>Some features are temporarily unavailable</AlertTitle>
          <AlertDescription>
            Media storage and some dashboard/report services are currently limited in this demo
            environment. Core CareGrid AI functionality remains available.
          </AlertDescription>
        </div>
      </Alert>
    </div>
  );
}
