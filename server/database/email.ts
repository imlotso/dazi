// PostgreSQL TEXT cannot contain NUL. Keep legacy addresses reversible while
// leaving ordinary addresses unchanged for search and operations.
const prefix = '~dazi-email~';
export function encodeEmail(value: string) {
  return value.includes('\0') || value.startsWith(prefix) ? prefix + Buffer.from(value, 'utf8').toString('base64') : value;
}
export function decodeEmail(value: string) {
  if (!value.startsWith(prefix)) return value;
  const encoded = value.slice(prefix.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('Invalid encoded email');
  return bytes.toString('utf8');
}
