/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true
  },
  env: {},
  // Allow builds with both Turbopack (Next 16 default) and webpack
  turbopack: {},
  webpack: (config, { isServer }) => {
    // Ignore fs/path modules in browser bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
    // Stop watching logs directory to prevent HMR during streaming.
    // Also ignore Windows XP-era junction points in user profile that loop
    // back on themselves and cause `EPERM: operation not permitted, scandir`
    // on GitHub Actions runners (cascades into FlightClientEntryPlugin
    // crash). Local Windows users with normal accounts don't hit this.
    // Single regex (webpack rejects mixed regex + glob strings in array).
    config.watchOptions = {
      ...config.watchOptions,
      ignored: /[\\/](logs|\.next|Application Data|Local Settings)[\\/]/,
    };
    // Disable webpack's user-profile + node_modules snapshotting that
    // triggers the same EPERM scan during `next build` on CI Windows.
    config.snapshot = {
      ...(config.snapshot || {}),
      managedPaths: [],
      immutablePaths: [],
    };
    return config;
  },
  async rewrites() {
    return [
      {
        source: "/v1/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1/v1",
        destination: "/api/v1"
      },
      {
        source: "/codex/:path*",
        destination: "/api/v1/responses"
      },
      {
        source: "/v1/:path*",
        destination: "/api/v1/:path*"
      },
      {
        source: "/v1",
        destination: "/api/v1"
      }
    ];
  }
};

export default nextConfig;
