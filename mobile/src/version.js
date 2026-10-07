// Version helpers (pure, testable without Capacitor).

/** Is version a newer than b? Compares numeric x.y.z; ignores a leading "v". */
export function isNewer(a, b) {
  const parse = (v) => String(v ?? '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
