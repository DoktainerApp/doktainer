import assert from "node:assert/strict";
import test from "node:test";

import { extractNginxDomainTargets } from "../../src/server/services/ssh-services/domains";

test("nginx sync resolves each shared domain from its own server block", () => {
  const config = `
# doktainer-managed: true
# doktainer-config-mode: SHARED
# doktainer-primary-domain: example.com
server {
  listen 80;
  server_name example.com;

  location / {
    proxy_pass http://frontend:3000;
  }
}

server {
  listen 80;
  server_name api.example.com;

  location / {
    proxy_pass http://backend:8080;
  }
}
`;

  assert.deepEqual(extractNginxDomainTargets(config), [
    { name: "example.com", host: "frontend", port: 3000 },
    { name: "api.example.com", host: "backend", port: 8080 },
  ]);
});

test("nginx sync prefers the proxied HTTPS block over an HTTP redirect block", () => {
  const config = `
server {
  listen 80;
  server_name example.com api.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name example.com;
  location / { proxy_pass http://frontend:3000; }
}

server {
  listen 443 ssl;
  server_name api.example.com;
  location / { proxy_pass http://backend:8080; }
}
`;

  assert.deepEqual(extractNginxDomainTargets(config), [
    { name: "example.com", host: "frontend", port: 3000 },
    { name: "api.example.com", host: "backend", port: 8080 },
  ]);
});

test("nginx sync keeps multiple names in one server block on the same target", () => {
  const config = `
server {
  listen 80;
  server_name example.com www.example.com;
  location / { proxy_pass http://frontend:3000; }
}
`;

  assert.deepEqual(extractNginxDomainTargets(config), [
    { name: "example.com", host: "frontend", port: 3000 },
    { name: "www.example.com", host: "frontend", port: 3000 },
  ]);
});
