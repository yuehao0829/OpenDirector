export function textToArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function arrayBufferToText(data: ArrayBuffer): string {
  return new TextDecoder().decode(data);
}
