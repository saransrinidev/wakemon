/** @type {import('next').NextConfig} */
const API_URL = process.env.MUSIC_API_URL || "http://127.0.0.1:8787";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;