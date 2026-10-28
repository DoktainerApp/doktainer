export function createLatestRequestGuard() {
  let sequence = 0;
  return () => {
    const request = ++sequence;
    return () => request === sequence;
  };
}
