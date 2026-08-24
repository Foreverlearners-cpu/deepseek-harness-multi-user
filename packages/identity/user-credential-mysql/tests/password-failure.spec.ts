import { beforeEach, describe, expect, it, vi } from 'vitest'

const scrypt = vi.fn()

vi.mock('node:crypto', () => ({
  randomBytes: (size: number) => Buffer.alloc(size),
  scrypt,
  timingSafeEqual: vi.fn(() => false),
}))

describe('password verifier failures', () => {
  beforeEach(() => {
    scrypt.mockReset()
  })

  it('propagates scrypt failures without producing verifier material', async () => {
    scrypt.mockImplementation((_password, _salt, _length, _options, callback: (error: Error | null, key: Buffer) => void) => {
      callback(new Error('scrypt unavailable'), Buffer.alloc(0))
    })
    const { createPasswordVerifier } = await import('../src/password.ts')
    await expect(createPasswordVerifier('secret')).rejects.toThrow(/scrypt unavailable/)
  })
})
