import { Alert, AlertDescription, AlertIcon, AlertTitle } from '@/components/ui';

export function DemoAvailabilityNotice() {
  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 pt-2 sm:px-6 sm:pt-3 lg:px-8">
      <Alert tone="info" role="status" className="rounded-control py-2 sm:py-3">
        <AlertIcon tone="info" />
        <div className="hidden min-w-0 sm:block">
          <AlertTitle>Some features are temporarily unavailable</AlertTitle>
          <AlertDescription>
            Media storage and some dashboard/report services are currently limited in this demo
            environment. Core CareGrid AI functionality remains available.
          </AlertDescription>
        </div>
        <details className="min-w-0 flex-1 sm:hidden">
          <summary className="cursor-pointer list-none text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            Some features are temporarily unavailable
            <span className="ml-1 font-normal text-secondary">· Details</span>
          </summary>
          <p className="mt-2 text-sm leading-5 text-secondary">
            Media storage and some dashboard/report services are currently limited in this demo
            environment. Core CareGrid AI functionality remains available.
          </p>
        </details>
      </Alert>
    </div>
  );
}
