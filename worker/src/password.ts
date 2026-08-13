/**
 * Password hashing on Web Crypto.
 *
 * The Python app used bcrypt. Workers has no native modules, so bcrypt is not
 * available at all — PBKDF2-HMAC-SHA256 is what the runtime offers that is
 * actually designed for passwords. Existing bcrypt hashes cannot be verified
 * here, which is why the accounts have to be re-seeded rather than copied.
 *
 * Deliberately dependency-free and free of Hono/Workers imports: `npm run seed`
 * runs this same file under Node so a seeded hash is produced by exactly the
 * code that will later verify it.
 *
 * Stored form: pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
 * The iteration count travels with the hash, so raising PBKDF2_ITERATIONS later
 * leaves already-stored hashes verifiable at the cost they were made with.
 */

const ALGORITHM = "pbkdf2_sha256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

/**
 * Buffer-backed bytes.
 *
 * Spelled out rather than left as a bare `Uint8Array`, whose buffer type
 * defaults to `ArrayBufferLike` — which includes SharedArrayBuffer and so is
 * not assignable to Web Crypto's `BufferSource`.
 */
type Bytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Bytes,
  iterations: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  iterations: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Length-independent, value-constant-time comparison. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;

  const [algorithm, iterationsRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM) return false;

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  try {
    const expected = fromBase64(hashRaw);
    const actual = await derive(password, fromBase64(saltRaw), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    // A malformed hash is a failed verification, not a crash.
    return false;
  }
}
