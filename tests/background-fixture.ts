import { deflateSync } from 'node:zlib';

/** A real grayscale PNG; one-bit pixels keep even oversized-dimension regression fixtures small. */
export function pngFixture(width: number, height: number, animated = false) {
  const chunk = (kind: string, bytes: Buffer) => {
    const payload = Buffer.concat([Buffer.from(kind), bytes]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, payload, suffix]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 1;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(width, 4); frame.writeUInt32BE(height, 8); frame.writeUInt16BE(1, 20); frame.writeUInt16BE(1, 22);
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...animated ? [chunk('acTL', animation), chunk('fcTL', frame)] : [],
    chunk('IDAT', deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height))), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + bytes.toString('base64');
}
