export const PASSWORD_ITERATIONS = 210_000;

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations = PASSWORD_ITERATIONS) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("密碼至少需要 8 個字元");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, iterations);
  return { passwordHash: bytesToBase64(hash), passwordSalt: bytesToBase64(salt), passwordIterations: iterations };
}

export async function verifyPassword(password, record) {
  try {
    const actual = await derivePassword(password, base64ToBytes(record.passwordSalt), Number(record.passwordIterations));
    const expected = base64ToBytes(record.passwordHash);
    if (actual.length !== expected.length)
      return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
    return difference === 0;
  } catch {
    return false;
  }
}
