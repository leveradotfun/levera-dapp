import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  serverExternalPackages: ["pg"],
  webpack: (config) => {
    // frontend/db is a symlink to the sibling ../db package. Webpack's default symlink handling
    // resolves it to its REAL path before resolving further imports, so `db/pool.ts`'s `import
    // "pg"` walks up from the monorepo's db/ directory (db/node_modules, then the repo root) --
    // never frontend/node_modules, where `pg` is actually installed by `npm install` here. That
    // walk only ever worked locally because db/node_modules/pg happened to already exist from
    // setting up db/ directly; a clean clone (Vercel's build machine, CI, anyone else) never
    // installs db/'s own dependencies at all, since it's outside the configured Root Directory.
    // Turning this off makes webpack treat the symlink as if it were physically inside frontend/,
    // so it resolves through frontend/node_modules instead -- exactly where `pg` already is.
    config.resolve.symlinks = false;
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core/client": false,
      "@x402/core": false,
      "@x402/svm/exact/client": false,
      "@x402/svm": false,
      "@x402/evm": false,
      "pino-pretty": false,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;
