export function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
