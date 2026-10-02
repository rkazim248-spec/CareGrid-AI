import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Keep `next dev` output separate from `next build` / `next start`. Sharing
  // `.next` lets a production build replace webpack chunks while a dev server
  // is serving them, causing missing vendor-chunk runtime errors.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // Do not advertise the framework (docs/19_DEPLOYMENT_DEVOPS.md §2)
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  experimental: {
    // next@15.5.x: the devtools segment explorer injects
    // next-devtools/userspace/app/segment-explorer-node.js#SegmentViewNode as a client
    // reference that is never registered in the React Client Manifest, which crashes dev
    // with "Could not find the module ... in the React Client Manifest". Remove this once
    // the installed next version has the fix.
    devtoolSegmentExplorer: false,
  },
};

export default nextConfig;
