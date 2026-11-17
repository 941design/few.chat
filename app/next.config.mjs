import { execSync } from 'child_process';

// When invoked via `make build`, BUILD_VERSION is passed as an env var so both
// the bundle and version.json derive from the same computed value. Fall back to
// execSync for direct `next build` / `next dev` invocations outside Make.
let BUILD_VERSION;
try {
  BUILD_VERSION =
    process.env.NEXT_PUBLIC_BUILD_VERSION ||
    execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  BUILD_VERSION = Date.now().toString();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_VERSION: BUILD_VERSION,
  },
  output: 'export',
  basePath: '',
  trailingSlash: true,
  reactStrictMode: true,

  // Disable SWC minification — the ts-mls package contains bitwise expressions
  // that crash the SWC optimizer (FRACTIONAL_BITWISE_OPERAND). Use Terser instead.
  // This setting is deprecated in Next.js 15 but required here for Next.js 14.
  swcMinify: false,

  webpack: (config) => {
    // Import `.md` content files as raw strings (long-form page content lives in
    // markdown, per CLAUDE.md's content/i18n split). `asset/source` yields the
    // file's text as the module's default export — resolved at build time, so it
    // works under `output: 'export'`.
    config.module.rules.push({
      test: /\.md$/,
      type: 'asset/source',
    });

    // For modules that crash SWC's optimizer, use a custom babel-loader rule
    // that handles only those specific packages.
    config.module.rules.push({
      test: /\.m?js$/,
      include: [
        /node_modules\/ts-mls/,
        /node_modules\/@internet-privacy\/marmot-ts/,
        /node_modules\/@noble\/post-quantum/,
        /node_modules\/@hpke\//,
        // @941design/marmot adoption: the library packages ship untranspiled
        // ES2022+ ESM and (via marmot-engine's `ts-mls` alias, whose path
        // still matches the ts-mls entry above) the same bitwise code that
        // crashes the SWC optimizer. `marmot` also matches `marmot-engine`.
        /node_modules\/@941design\/marmot/,
        /node_modules\/@941design\/nostr-events/,
      ],
      use: {
        // Use next-swc with no optimization for these files
        loader: 'next-swc-loader',
        options: {
          isServer: false,
          pagesDir: undefined,
          hasServerComponents: false,
          fileReading: false,
        },
      },
    });

    return config;
  },
};

export default nextConfig;
