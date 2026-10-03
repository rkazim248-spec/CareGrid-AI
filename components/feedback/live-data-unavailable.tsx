import Link from 'next/link';
import { Database } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
} from '@/components/ui';

export function LiveDataUnavailable({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="flex max-w-3xl flex-col gap-5" aria-labelledby="unavailable-title">
      <header className="flex flex-col gap-2">
        <h1
          id="unavailable-title"
          className="text-balance text-2xl leading-tight font-semibold tracking-tight text-primary sm:text-3xl"
        >
          {title}
        </h1>
        <p className="max-w-[65ch] text-sm leading-6 text-secondary">{description}</p>
      </header>

      <Alert tone="warning" role="status">
        <AlertIcon tone="warning" />
        <div>
          <AlertTitle className="flex items-center gap-2">
            <Database className="size-4" aria-hidden="true" />
            Live data is not connected
          </AlertTitle>
          <AlertDescription>
            This screen is not backed by a live service in this build. No sample or demo records are
            shown.
          </AlertDescription>
        </div>
      </Alert>

      <Button asChild variant="secondary" size="lg" className="min-h-11 self-start">
        <Link href="/dashboard">Return to dashboard</Link>
      </Button>
    </section>
  );
}
