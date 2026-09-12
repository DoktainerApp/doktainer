import { Transform } from "node:stream";

export const CUSTOM_RESTORE_SCRIPT_ARGS = [
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-privileges",
  "--file=-",
] as const;

export const ATOMIC_PSQL_RESTORE_ARGS = [
  "--single-transaction",
  "--set",
  "ON_ERROR_STOP=1",
] as const;

export function isUnsupportedRestoreSetting(line: string) {
  return line.trim() === "SET transaction_timeout = 0;";
}

export function createRestoreSqlSanitizer() {
  let pending = "";

  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      const output = lines
        .filter((line) => !isUnsupportedRestoreSetting(line))
        .map((line) => `${line}\n`)
        .join("");
      callback(null, output);
    },
    flush(callback) {
      callback(null, isUnsupportedRestoreSetting(pending) ? "" : pending);
    },
  });
}
