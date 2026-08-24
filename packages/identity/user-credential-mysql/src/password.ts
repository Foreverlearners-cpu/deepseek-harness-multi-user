/** Versioned scrypt password verifier owned by the MySQL credential Provider. */

import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'

/** Current persisted password verifier format. */
export const PASSWORD_VERIFIER_VERSION = 1
/** Version-1 scrypt CPU and memory cost. */
export const SCRYPT_COST = 16_384
/** Version-1 scrypt block-size parameter. */
export const SCRYPT_BLOCK_SIZE = 8
/** Version-1 scrypt parallelization parameter. */
export const SCRYPT_PARALLELIZATION = 1
/** Bytes generated for each random version-1 salt. */
export const SCRYPT_SALT_BYTES = 16
/** Bytes generated for each version-1 derived key. */
export const SCRYPT_KEY_BYTES = 32
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024

/** Persisted verifier fields; callers must never expose this value. */
export interface PasswordVerifier {
  readonly version: number
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
  readonly salt: Buffer
  readonly derivedKey: Buffer
}

function supported(verifier: PasswordVerifier): boolean {
  return verifier.version === PASSWORD_VERIFIER_VERSION
    && verifier.cost === SCRYPT_COST
    && verifier.blockSize === SCRYPT_BLOCK_SIZE
    && verifier.parallelization === SCRYPT_PARALLELIZATION
    && Buffer.isBuffer(verifier.salt)
    && verifier.salt.byteLength === SCRYPT_SALT_BYTES
    && Buffer.isBuffer(verifier.derivedKey)
    && verifier.derivedKey.byteLength === SCRYPT_KEY_BYTES
}

async function derive(password: string, verifier: Omit<PasswordVerifier, 'derivedKey'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, verifier.salt, SCRYPT_KEY_BYTES, {
      N: verifier.cost,
      r: verifier.blockSize,
      p: verifier.parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => {
      if (error === null) resolve(key)
      else reject(error)
    })
  })
}

/** Create a verifier with fresh random salt.
 * @param password - validated raw password.
 * @returns private verifier fields suitable for persistence.
 */
export async function createPasswordVerifier(password: string): Promise<PasswordVerifier> {
  const parameters = {
    version: PASSWORD_VERIFIER_VERSION,
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    salt: randomBytes(SCRYPT_SALT_BYTES),
  }
  return { ...parameters, derivedKey: await derive(password, parameters) }
}

/** Verify a password using only supported, bounded parameters.
 * @param password - validated candidate password.
 * @param verifier - private persisted or dummy verifier.
 * @returns true only when the derived keys match.
 */
export async function verifyPasswordVerifier(password: string, verifier: PasswordVerifier): Promise<boolean> {
  if (!supported(verifier)) throw new Error('user-credential-mysql: unsupported password verifier')
  const candidate = await derive(password, verifier)
  return timingSafeEqual(candidate, verifier.derivedKey)
}
