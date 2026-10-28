import type { Domain } from "@/lib/api";

export function sanitizeDomainForCache(domain: Domain): Domain {
  const cert = domain.sslCert;
  if (!cert) return domain;
  return {
    ...domain,
    sslCert: {
      id: cert.id, domainId: cert.domainId, issuer: cert.issuer,
      issuedAt: cert.issuedAt, expiresAt: cert.expiresAt, status: cert.status,
      autoRenew: cert.autoRenew, createdAt: cert.createdAt, updatedAt: cert.updatedAt,
    },
  };
}
