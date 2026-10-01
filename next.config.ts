import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
