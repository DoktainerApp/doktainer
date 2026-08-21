import type { NextConfig } from "next";

const contentSecurityPolicyDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self' https://github.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' http: https: ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
] as const;

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicyDirectives.join("; "),
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
] as const;

const nextConfig: NextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.12.11"],
  devIndicators: false,
  experimental: {
    // Domain provisioning can include SSH, Nginx validation/reload, and
    // Certbot work. Keep the same-origin rewrite alive long enough for the
    // backend to return its structured result instead of a proxy-generated
    // non-JSON 500 response.
    proxyTimeout: 5 * 60 * 1000,
  },
  async rewrites() {
    const backendUrl =
      process.env.INTERNAL_API_URL ||
      process.env.BACKEND_URL ||
      `http://127.0.0.1:4000`;

    return [
      {
        source: "/api/v1/:path*",
        destination: `${backendUrl}/api/v1/:path*`,
      },
      {
        source: "/health",
        destination: `${backendUrl}/health`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...securityHeaders],
      },
    ];
  },
};

export default nextConfig;
