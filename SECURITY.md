# Security Policy

Thank you for helping keep Doktainer and its users secure.

## Supported Versions

The following versions currently receive security updates:

| Version                    | Supported |
| -------------------------- | --------- |
| Latest Milestone Release   | ✅        |
| Previous Milestone Release | ✅        |
| Older Releases             | ❌        |

As Doktainer is currently in the pre-1.0 phase, users are encouraged to always upgrade to the latest available release.

## Reporting a Vulnerability

If you discover a security vulnerability, please do **not** create a public GitHub Issue.

Instead, report the vulnerability privately through:

- GitHub Security Advisories (preferred)
- GitHub Private Vulnerability Reporting

Please include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested mitigation (if available)

## Response Process

After receiving a report, the Doktainer maintainers will:

1. Acknowledge receipt of the report.
2. Investigate and validate the issue.
3. Develop and test a fix.
4. Release a security update if necessary.
5. Publicly disclose the vulnerability after a fix is available.

## Scope

Examples of security vulnerabilities include:

- Authentication bypass
- Privilege escalation
- Remote code execution
- Command injection
- Server-side request forgery (SSRF)
- Sensitive information disclosure
- Container escape vulnerabilities
- Insecure secret handling

## Disclosure Policy

Please allow maintainers a reasonable amount of time to investigate and address reported vulnerabilities before publicly disclosing them.

Responsible disclosure helps protect Doktainer users and infrastructure operators.

## Security Updates

Security fixes may be released as maintenance releases:

- v0.x.1
- v0.x.2
- v0.x.3

or, when necessary, included in the next milestone release.

## Production Encryption Key

Doktainer uses `ENCRYPTION_KEY` to encrypt SSH credentials, integration secrets,
and deployment rollback snapshots at rest.

- Production startup requires a non-placeholder key of at least 32 characters.
- Generate a key with a cryptographically secure generator, for example
  `openssl rand -hex 32`.
- Store the key in a secret manager or protected runtime environment file. Do
  not commit the production value to Git.
- Keep the key stable across application restarts and deployments. Losing it
  makes existing encrypted records unreadable.

### Rotation procedure

Do not replace `ENCRYPTION_KEY` directly while encrypted records still use the
old key. A safe rotation requires:

1. Back up the database and verify the backup can be restored.
2. Stop writes that create or update encrypted records.
3. Decrypt every encrypted record with the old key and re-encrypt it with the
   new key, including deployment `rollbackSnapshotEnc` values.
4. Verify representative SSH credentials, integrations, 2FA secrets, storage
   destinations, and rollback snapshots before switching traffic.
5. Deploy the new key, restart all backend instances, and remove the old key
   only after verification succeeds.

The current encrypted payload format does not contain a key identifier.
Operators should therefore treat key rotation as a controlled maintenance
operation until versioned key-ring support is implemented.

## Acknowledgements

We appreciate responsible security researchers and community members who help improve the security of Doktainer.
