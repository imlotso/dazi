export type BackgroundTheme = 'light' | 'dark';
export type BackgroundImage = { image: string; name: string; width: number; height: number };
export type BackgroundConfig = BackgroundImage & {
  fit: 'cover' | 'contain'; positionX: number; positionY: number; blur: number; shade: number;
};

export const maxBackgroundBytes = 768 * 1024;
const maxDataLength = Math.ceil(maxBackgroundBytes / 3) * 4;
const fields = ['image', 'name', 'width', 'height', 'fit', 'positionX', 'positionY', 'blur', 'shade'];
const inRange = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function rasterDimensions(value: unknown): { width: number; height: number } | undefined {
  if (typeof value !== 'string' || value.length > maxDataLength + 30) return;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > maxDataLength || match[2].length % 4 !== 0) return;
  try {
    const bytes = atob(match[2]);
    const be16 = (at: number) => bytes.charCodeAt(at) * 256 + bytes.charCodeAt(at + 1);
    const be32 = (at: number) => be16(at) * 65536 + be16(at + 2);
    const le16 = (at: number) => bytes.charCodeAt(at) + bytes.charCodeAt(at + 1) * 256;
    const le24 = (at: number) => le16(at) + bytes.charCodeAt(at + 2) * 65536;
    const le32 = (at: number) => le16(at) + le16(at + 2) * 65536;
    if (match[1] === 'png') {
      if (bytes.length < 45 || !bytes.startsWith('\x89PNG\r\n\x1a\n') || be32(8) !== 13 || bytes.slice(12, 16) !== 'IHDR' || bytes.slice(-8, -4) !== 'IEND') return;
      let hasPixels = false;
      for (let at = 8; at + 12 <= bytes.length;) {
        const length = be32(at); const chunk = bytes.slice(at + 4, at + 8);
        if (!Number.isFinite(length) || at + length + 12 > bytes.length) return;
        if (['acTL', 'fcTL', 'fdAT'].includes(chunk)) return;
        if (chunk === 'IDAT') hasPixels = true;
        if (chunk === 'IEND') return hasPixels && length === 0 && at + 12 === bytes.length ? { width: be32(16), height: be32(20) } : undefined;
        at += length + 12;
      }
      return;
    }
    if (match[1] === 'jpeg') {
      if (!bytes.startsWith('\xff\xd8\xff') || !bytes.endsWith('\xff\xd9')) return;
      for (let at = 2; at < bytes.length;) {
        if (bytes.charCodeAt(at++) !== 255) return;
        while (bytes.charCodeAt(at) === 255) at++;
        const marker = bytes.charCodeAt(at++);
        if (marker === 0xda || marker === 0xd9) return;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = be16(at);
        if (length < 2 || !Number.isFinite(length) || at + length > bytes.length) return;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          if (length < 8) return;
          return { width: be16(at + 5), height: be16(at + 3) };
        }
        at += length;
      }
      return;
    }
    if (!bytes.startsWith('RIFF') || bytes.slice(8, 12) !== 'WEBP' || le32(4) + 8 !== bytes.length) return;
    let canvas: { width: number; height: number } | undefined;
    let image: { width: number; height: number } | undefined;
    for (let at = 12; at + 8 <= bytes.length;) {
      const chunk = bytes.slice(at, at + 4); const length = le32(at + 4); const start = at + 8;
      if (!Number.isFinite(length) || start + length > bytes.length) return;
      if (chunk === 'ANIM' || chunk === 'ANMF') return;
      if (chunk === 'VP8X') {
        if (length !== 10 || (bytes.charCodeAt(start) & 2)) return;
        canvas = { width: le24(start + 4) + 1, height: le24(start + 7) + 1 };
      } else if (chunk === 'VP8 ') {
        if (length < 10 || bytes.slice(start + 3, start + 6) !== '\x9d\x01\x2a') return;
        image = { width: le16(start + 6) & 0x3fff, height: le16(start + 8) & 0x3fff };
      } else if (chunk === 'VP8L') {
        if (length < 5 || bytes.charCodeAt(start) !== 0x2f) return;
        const bits = le32(start + 1);
        image = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      at = start + length + (length % 2);
    }
    if (canvas && (canvas.width !== image?.width || canvas.height !== image?.height)) return;
    return image;
  } catch { return; }
}

export function isBackgroundImageData(value: unknown): value is string {
  const size = rasterDimensions(value);
  return !!size && inRange(size.width, 1, 2560) && inRange(size.height, 1, 2560);
}

export function isBackgroundConfig(value: unknown): value is BackgroundConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const size = rasterDimensions(item.image);
  return Object.keys(item).every((key) => fields.includes(key)) && !!size && size.width === item.width && size.height === item.height &&
    typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(item.name) &&
    Number.isInteger(item.width) && inRange(item.width, 1, 2560) && Number.isInteger(item.height) && inRange(item.height, 1, 2560) &&
    (item.fit === 'cover' || item.fit === 'contain') && inRange(item.positionX, 0, 100) && inRange(item.positionY, 0, 100) &&
    inRange(item.blur, 0, 12) && inRange(item.shade, 0, 80);
}

export function defaultBackground(theme: BackgroundTheme, image: BackgroundImage): BackgroundConfig {
  return { ...image, fit: 'cover', positionX: 50, positionY: 50, blur: 0, shade: theme === 'dark' ? 40 : 20 };
}

async function decodeImage(file: File, signal?: AbortSignal): Promise<HTMLImageElement> {
  signal?.throwIfAborted();
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const cleanup = () => { clearTimeout(timer); image.onload = null; image.onerror = null; signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new DOMException('已取消', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('图片读取超时')); }, 15_000);
      image.onload = () => { cleanup(); resolve(image); };
      image.onerror = () => { cleanup(); reject(new Error('图片无法读取')); };
      signal?.addEventListener('abort', abort, { once: true });
      image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export async function prepareBackgroundImage(file: File, signal?: AbortSignal): Promise<BackgroundImage> {
  const mime = file.type || (/\.jpe?g$/i.test(file.name) ? 'image/jpeg' : /\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : '');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
  if (!file.size) throw new Error('图片无法读取');
  const original = await decodeImage(file, signal);
  signal?.throwIfAborted();
  if (!original.naturalWidth || !original.naturalHeight || original.naturalWidth * original.naturalHeight > 40_000_000) throw new Error('图片尺寸不能超过 4000 万像素');
  const scale = Math.min(1, 2560 / Math.max(original.naturalWidth, original.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(original.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(original.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法处理图片');
  const name = file.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120) || '背景图';
  for (let attempt = 0; attempt < 10; attempt++) {
    signal?.throwIfAborted();
    if (attempt >= 3) { canvas.width = Math.max(1, Math.round(canvas.width * .8)); canvas.height = Math.max(1, Math.round(canvas.height * .8)); }
    context.drawImage(original, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/webp', attempt < 3 ? [.86, .7, .54][attempt] : .7);
    if (isBackgroundImageData(image)) return { image, name, width: canvas.width, height: canvas.height };
  }
  throw new Error('图片压缩失败，请选择其他图片');
}
