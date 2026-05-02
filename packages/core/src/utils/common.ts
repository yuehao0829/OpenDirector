export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}

export function generateRandomHexPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isRemoteUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://') || url.startsWith('data:');
}

export function isAssetUrl(url: string): boolean {
  return url.startsWith('asset://');
}

/** Map internal AssetType to Ark API PascalCase format. */
export function toArkAssetType(type: 'video' | 'image' | 'audio'): string {
  return type === 'video' ? 'Video' : type === 'audio' ? 'Audio' : 'Image';
}
