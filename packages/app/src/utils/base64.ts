const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_OR_WHITESPACE = /[\s_-]/;

/**
 * Decodes standard base64 or base64url to bytes. Whitespace and missing padding are tolerated.
 *
 * Returns null for anything else instead of letting `atob` throw `InvalidCharacterError`.
 * Timeline payloads are not guaranteed to be base64: the daemon cuts oversized strings and
 * appends a `…[truncated N KB]` marker, and providers can store references such as
 * `blob:sha256:<hash>`. Callers that render show a placeholder for null.
 */
export function decodeBase64(input: string): Uint8Array<ArrayBuffer> | null {
  const normalized = BASE64URL_OR_WHITESPACE.test(input)
    ? input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
    : input;
  if (!CANONICAL_BASE64.test(normalized)) {
    return null;
  }
  const unpadded = normalized.replace(/=+$/, "");
  // A single trailing character cannot encode a whole byte.
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const binary = atob(unpadded.padEnd(unpadded.length + ((4 - (unpadded.length % 4)) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Like {@link decodeBase64}, for callers that report a failure instead of rendering one. */
export function decodeBase64OrThrow(input: string, label: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(input);
  if (!bytes) {
    throw new Error(`${label} is not valid base64.`);
  }
  return bytes;
}
