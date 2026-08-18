import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import KafkaService from '@deepseek-ai/dsh-kafka'

const brokers = process.env.DSH_KAFKA_BROKERS?.split(',').filter(Boolean)

describe.skipIf(brokers === undefined || brokers.length === 0)('KafkaService real broker', () => {
  it('connects, refreshes metadata, and disconnects cleanly', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, {
      binding: 'e2e',
      brokers: brokers!,
      clientId: 'dsh-kafka-e2e',
      tls: false,
      requestTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      retries: 3,
      retryDelayMs: 300,
    })

    try {
      const health = await ctx.kafka.health()
      expect(health.binding).toBe('e2e')
      expect(health.clusterId.trim().length).toBeGreaterThan(0)
      expect(health.brokerCount).toBeGreaterThan(0)
    } finally {
      await fiber.dispose()
    }
  })
})
