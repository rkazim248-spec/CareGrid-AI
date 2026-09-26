import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Do not advertise the framework (docs/19_DEPLOYMENT_DEVOPS.md §2)
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
};

export default nextConfig;
