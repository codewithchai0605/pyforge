/** Small formatting helpers for the package pages. Pure, so they are unit-tested. */

/** 2_460_723_068 -> "2.5B", 40_000_000 -> "40M", 1_250 -> "1.3K", 87 -> "87". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size;
      // Two significant digits below 10, none after the point from 10 up.
      const text =
        v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
      // 999_999 rounds to "1000K": say "1M" instead.
      if (text === "1000" && suffix !== "B") return formatCount(size * 1000);
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "just now", "3 hours ago", "2 days ago" for a Unix time in seconds. */
export function timeAgo(
  epochSeconds: number | null,
  nowMs = Date.now(),
): string {
  if (epochSeconds === null) return "never";
  const s = Math.max(0, Math.round(nowMs / 1000 - epochSeconds));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** PyPI treats "_", "." and "-" runs as the same and ignores case. */
export const canonicalName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
