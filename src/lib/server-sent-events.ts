export interface ParsedServerSentEvent {
  event: string;
  data: unknown;
}

/**
 * Parse one SSE block without allowing a malformed upstream payload to abort
 * the whole log stream. Some reverse proxies can surface a plain-text backend
 * error in an otherwise valid event stream.
 */
export function parseServerSentEventBlock(
  block: string,
): ParsedServerSentEvent | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(rawData) as unknown };
  } catch {
    return { event, data: rawData };
  }
}
