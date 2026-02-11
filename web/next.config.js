/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable StrictMode to prevent double-mounting that confuses wallet adapter
  // This can cause 30+ second delays in wallet popup due to re-handshake stalls
  reactStrictMode: false,

  // Skip ESLint during builds (project doesn't have ESLint configured)
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Transpile snarkjs and its dependencies for proper bundling
  transpilePackages: ['snarkjs', 'ffjavascript', 'circomlibjs'],

  webpack: (config, { isServer }) => {
    // Handle Web Workers
    config.module.rules.push({
      test: /\.worker\.(js|ts)$/,
      use: { loader: 'worker-loader' },
    });

    // Polyfill for crypto in browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        fs: false,
        path: false,
        stream: false,
      };

      // Prevent snarkjs from being split into chunks (causes loading issues)
      config.optimization.splitChunks = {
        ...config.optimization.splitChunks,
        cacheGroups: {
          ...config.optimization.splitChunks?.cacheGroups,
          snarkjs: {
            test: /[\\/]node_modules[\\/](snarkjs|ffjavascript|circomlibjs)[\\/]/,
            name: 'snarkjs-bundle',
            chunks: 'all',
            priority: 30,
          },
        },
      };
    }

    // Ignore pino-pretty (optional logging dependency from WalletConnect)
    config.resolve.alias = {
      ...config.resolve.alias,
      'pino-pretty': false,
    };

    return config;
  },
  // Allow large circuit files
  experimental: {
    largePageDataBytes: 128 * 1000 * 1000, // 128MB
  },
};

module.exports = nextConfig;
