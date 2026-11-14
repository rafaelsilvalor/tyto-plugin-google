/**
 * Base64 written here: the plugin may not use Node's `Buffer`, and `atob` would be one more
 * global to rely on. The cursor of `google.sheet-rows` is its only user.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64url with no padding. */
export function base64Url(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += ALPHABET[(triple >> 18) & 63];
    encoded += ALPHABET[(triple >> 12) & 63];
    if (second !== undefined) encoded += ALPHABET[(triple >> 6) & 63];
    if (third !== undefined) encoded += ALPHABET[triple & 63];
  }
  return encoded.replace(/\+/g, '-').replace(/\//g, '_');
}

/** Standard base64, padded or not, to bytes; `undefined` for any other character. */
export function base64Decode(text: string): Uint8Array<ArrayBuffer> | undefined {
  const unpadded = text.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (const character of unpadded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return undefined;
    // Fewer than 14 bits are ever pending, so the rest is dropped before it can overflow.
    buffer = ((buffer << 6) | value) & 0x3fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }
  return bytes;
}
