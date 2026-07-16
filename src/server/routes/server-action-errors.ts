function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function formatServerActionError(
  error: unknown,
  fallbackMessage: string,
) {
  const message = getErrorText(error);

  const portMatch = message.match(/(?:0\.0\.0\.0|:::):(?:80|443).*?(?:address already in use|already in use)/i);
  if (portMatch || /address already in use/i.test(message)) {
    return "The service could not start because port 80 or 443 is already in use by another host process or Docker container.";
  }

  if (/syntax error|unexpected token|command not found|bad substitution/i.test(message)) {
    return "The remote host rejected the generated shell command before it could finish. Refresh the server snapshot and retry the action.";
  }

  return fallbackMessage;
}


