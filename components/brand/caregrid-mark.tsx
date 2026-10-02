import type { SVGProps } from 'react';

export function CareGridMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
      {...props}
    >
      <path d="M16 3v7m0 12v7M3 16h7m12 0h7" />
      <circle cx="16" cy="16" r="5" />
      <path d="M16 13.5v5m-2.5-2.5h5" />
      <circle cx="16" cy="3" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16" cy="29" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="16" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="29" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
