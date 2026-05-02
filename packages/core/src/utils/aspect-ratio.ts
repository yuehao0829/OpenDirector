/** Parse aspect ratio string like '16:9' to a numeric value (width/height). Returns null for 'adaptive'. */
export function parseAspectRatio(ar: string | undefined | null): number | null {
  if (!ar || ar === 'adaptive') return null;
  const parts = ar.split(':');
  if (parts.length !== 2) return null;
  const w = parseFloat(parts[0]);
  const h = parseFloat(parts[1]);
  if (!w || !h) return null;
  return w / h;
}
