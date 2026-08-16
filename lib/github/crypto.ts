function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(utf8(value))),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const length = derLength(content.length);
  const value = new Uint8Array(1 + length.length + content.length);
  value[0] = tag;
  value.set(length, 1);
  value.set(content, 1 + length.length);
  return value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const value = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.length;
  }
  return value;
}

function pemBytes(pem: string): Uint8Array {
  const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const normalized = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(normalized);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!pkcs1) return decoded;

  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaEncryptionAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return der(0x30, concat(version, rsaEncryptionAlgorithm, der(0x04, decoded)));
}

export async function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(
    utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    buffer(pemBytes(privateKey)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, buffer(utf8(unsigned))),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

export async function contentHash(content: string): Promise<string> {
  return sha256Hex(content);
}
