import { ApiError } from "../server/http";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function key(value: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(value);
  } catch {
    throw new ApiError(503, "CONNECTOR_KEY_INVALID", "Connector encryption is misconfigured.");
  }
  if (raw.byteLength !== 32) {
    throw new ApiError(503, "CONNECTOR_KEY_INVALID", "Connector encryption is misconfigured.");
  }
  return crypto.subtle.importKey("raw", arrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptConnectorSecret(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: arrayBuffer(iv) },
      await key(secret),
      new TextEncoder().encode(value),
    ),
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(encrypted)}`;
}

export async function decryptConnectorSecret(value: string, secret: string): Promise<string> {
  const [version, ivValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue) {
    throw new ApiError(500, "CONNECTOR_SECRET_INVALID", "Stored connector access is invalid.");
  }
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBuffer(base64ToBytes(ivValue)) },
      await key(secret),
      arrayBuffer(base64ToBytes(encryptedValue)),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new ApiError(500, "CONNECTOR_SECRET_INVALID", "Stored connector access could not be read.");
  }
}
