import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionMessageChangeUserId } from '@deepseek-ai/dsh-session-message-change-protocol'
import {
  SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION,
  SESSION_CONTEXT_CACHE_KEY_KIND,
  sessionContextCacheKey,
} from '../src/index.ts'

describe('session context cache key', () => {
  it('encodes deployment identity, format version, and user/session ids as JSON', () => {
    expect(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100'),
    })).toBe(JSON.stringify([
      SESSION_CONTEXT_CACHE_KEY_KIND,
      'deploy-a',
      SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION,
      'user-8',
      'session-100',
    ]))
    expect(SESSION_CONTEXT_CACHE_KEY_KIND).toBe('dsh.session.context')
    expect(SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION).toBe(1)
  })

  it('keeps user and session segments unambiguous when they contain punctuation', () => {
    const collidingJoin = 'user-8":"session-100'
    expect(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100'),
    })).not.toBe(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId(collidingJoin),
      sessionId: SessionId('other'),
    }))
    expect(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8","session-100'),
      sessionId: SessionId('x'),
    })).not.toBe(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100","x'),
    }))
  })

  it('separates keys across deployments and sessions', () => {
    const base = {
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100'),
    }
    expect(sessionContextCacheKey({ ...base, deploymentId: 'deploy-a' }))
      .not.toBe(sessionContextCacheKey({ ...base, deploymentId: 'deploy-b' }))
    expect(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100'),
    })).not.toBe(sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-101'),
    }))
  })
})
