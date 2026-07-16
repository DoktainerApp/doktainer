const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_CREDENTIAL_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:access_token|token|api_key|key|secret)=)[^&\s]+/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

function redactKnownSecrets(message: string, secrets: Array<string | null | undefined>) {
  return secrets.reduce<string>((current, secret) => {
    const normalized = secret?.trim();
    return normalized ? current.split(normalized).join("[REDACTED]") : current;
  }, message);
}

export function redactDeploymentErrorDetails(
  error: unknown,
  secrets: Array<string | null | undefined> = [],
) {
  return redactKnownSecrets(errorText(error), secrets)
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED PRIVATE KEY]")
    .replace(
      /\bauthorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi,
      "authorization: [REDACTED]",
    )
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "[REDACTED AUTHORIZATION]",
    )
    .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY_PATTERN, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export function sanitizeDeploymentError(
  error: unknown,
  options: {
    fallback?: string;
    secrets?: Array<string | null | undefined>;
  } = {},
) {
  const fallback = options.fallback || "Deployment operation failed";
  const message = redactDeploymentErrorDetails(error, options.secrets);
  if (!message) return fallback;

  if (/address already in use|port is already allocated|bind.*failed/i.test(message)) {
    return "The deployment could not start because a required host port is already in use.";
  }

  if (/no such image|pull access denied|manifest unknown/i.test(message)) {
    return "The deployment image could not be resolved or pulled from its registry.";
  }

  if (/no such container|container .* not found/i.test(message)) {
    return "The target container could not be found on the selected server.";
  }

  if (
    /command failed|docker (?:run|pull|inspect|rename|stop|rm)|bash:|sh:|stderr|stdout|prisma|stack|ssh/i.test(
      message,
    )
  ) {
    return fallback;
  }

  return message.slice(0, 800);
}


