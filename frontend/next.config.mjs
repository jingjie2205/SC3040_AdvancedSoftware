/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  distDir: process.env.NUTRITION_BROWSER_TEST === "1" ? ".next-nutrition-test" : ".next",
  experimental: {},
};

export default nextConfig;
