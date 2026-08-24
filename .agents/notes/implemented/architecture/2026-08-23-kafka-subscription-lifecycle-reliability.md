# Agent Note: Kafka subscription lifecycle reliability

Status: implemented

English | [中文](2026-08-23-kafka-subscription-lifecycle-reliability.zh.md)

## Problem

Durable Kafka consumers must resume committed offsets after restarts, distinguish an intentional close from an unexpected stream stop, and avoid reporting readiness before initial offsets are known. Unbounded dependency shutdown can also prevent Cordis disposal from reaching quiescence.

## Decision

`KafkaSubscribeRequest.fallbackMode` selects `earliest`, `latest`, or `fail` only when a consumer-group partition has no committed offset. Every subscription otherwise opens in committed mode. `subscribe()` resolves after the stream reports initial offsets, which prevents a pending initial latest lookup from skipping records published after the caller believes the subscription is ready.

`KafkaSubscription.done` resolves only after caller-initiated close. Handler failure, client failure, and unexpected stream completion reject it, so consumer plugins supervise the promise and own restart or terminal-failure policy. Successful handlers remain the only path to offset commit.

`requestTimeoutMs` bounds subscription readiness, active-handler drain, stream and client close, admitted publish drain, and Admin or Producer close. Graceful Consumer shutdown escalates to the dependency's forced close when the deadline or graceful call fails. Late dependency settlement remains contained and cannot become an unhandled rejection.

## Alternatives considered

**Let callers select committed, earliest, or latest for every start.** Rejected because choosing earliest or latest could ignore an existing committed offset and replay or skip durable work after a restart.

**Resolve subscription readiness when `consume()` returns a stream.** Rejected because the dependency can still be resolving initial offsets, especially for latest fallback, after the stream object exists.

**Treat unexpected stream completion as successful shutdown.** Rejected because the owning plugin would remain active while consuming no records.

**Wait indefinitely for dependency cleanup.** Rejected because one stalled network client would prevent application disposal from reaching quiescence.

## Verification

Focused transport tests pin committed-mode opening with explicit fallback, readiness after offset initialization, sequential commit ordering, failed-handler and unexpected-stream rejection, effect ownership, and bounded publish and client shutdown.

## Consequences

Every consumer must supply a fallback policy and supervise `subscription.done`. Consumer plugins that restart subscriptions retain ownership of backoff, retry exhaustion, poison-event handling, and durable-effect idempotence. A timed-out dependency operation may continue inside the client library, so deployments still need an outer process-shutdown deadline.
