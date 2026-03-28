export function getBufferPreview(buffer: Buffer, maxBytes = 24): string {
  if (buffer.length === 0) {
    return '0B';
  }

  const preview = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  const hex = Array.from(preview)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  const ascii = Array.from(preview)
    .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'))
    .join('');
  const suffix = buffer.length > maxBytes ? ' ...' : '';
  return `${buffer.length}B hex=[${hex}] ascii="${ascii}"${suffix}`;
}
