'use client';

/**
 * Last-resort boundary. Replaces the whole document, so it must supply its own
 * `<html>` and `<body>`. It deliberately does NOT re-initialise providers: if
 * the failure is in a provider, re-mounting it here would loop.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: '#0B0F14',
          color: '#E9EFF6',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'flex',
          minHeight: '100dvh',
          margin: 0,
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
        }}
      >
        <div style={{ maxWidth: '36rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ color: '#A8B6C6', marginTop: '0.5rem' }}>
            The application could not start. This is a development build of the CareGrid AI
            interface shell; no data is affected.
          </p>
          {error.digest ? (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#82909F', marginTop: '1rem' }}>
              Reference {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              backgroundColor: '#2AB3C9',
              color: '#04191D',
              border: 0,
              borderRadius: 6,
              padding: '0.625rem 1rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
