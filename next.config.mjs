/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    "/api/**": ["./config/**/*"],
  },
};
export default nextConfig;
