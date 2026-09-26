import { TrackView } from '@/features/track/track-view';

/**
 * `/track` — docs/04 §13.3.
 *
 * Next 15 App Router: `searchParams` is a Promise, so it is awaited here rather
 * than in a client hook. The reference is normalised to upper case so a link
 * pasted in lower case still resolves.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.ref) ? params.ref[0] : params.ref;

  return (
    <main id="main-content" className="flex-1 focus:outline-none" tabIndex={-1}>
      <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-6">
        <TrackView requestedRef={raw} />
      </div>
    </main>
  );
}
