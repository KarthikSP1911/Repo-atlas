/** Static export: plain HTML, CSS and an SVG. No API routes, no server code, nothing to run. */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
