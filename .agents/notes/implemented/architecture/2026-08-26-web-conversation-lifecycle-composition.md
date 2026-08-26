# Agent Note: Web conversation lifecycle composition

Status: implemented

English | [中文](2026-08-26-web-conversation-lifecycle-composition.zh.md)

## Problem

Conversation persistence requires explicit attachment before Agent publication, but Web creation, cold resume, ordinary fork, and built-in in-process subagent paths own separate setup callbacks. Installing the Conversation Provider alone therefore creates tables without making those runtime Sessions durable.

## Decision

`@deepseek-ai/dsh-conversation-web` is an optional Host service exposing one `AgentSetup` composer. ApiProxy and both in-process subagent lifecycle owners consume it through `ctx.get('conversationWeb')`; absence preserves their existing setup exactly. Existing preset, policy, and child setup completes first, attachment completes second, and the original publication commit is preserved.

Fresh Web Sessions and cold resumes use `dsh-conversation-starter` ownership and identity. An ordinary Web fork becomes an independent top-level Conversation with the same fixed deployment labels while its Session log retains fork ancestry. It does not set `parentConversationId`, which remains delegation lineage. Subagents retain `origin: 'subagent'` and inherit owner identity from their attached parent.

The plugin joins lifecycle only. Deployments separately mount MySQL, the Conversation MySQL Provider, the projection/write-behind Consumer, and the local ownership starter. Shipped defaults remain storage-neutral and MySQL credentials remain deployment configuration.

## Alternatives considered

**Make ApiProxy depend directly on Conversation persistence.** This would force a storage policy into the Web gateway and break deployments that intentionally do not install semantic persistence.

**Treat ordinary forks as subagents.** Fork ancestry describes copied history, not delegated execution. Reusing subagent lineage would corrupt Conversation queries and owner semantics.

**Attach from `session/created`.** That notification cannot reject publication or guarantee attachment before the first business event.

**Use the continuable-subagent setup registry for every path.** That registry owns synchronous, revocable child capabilities and does not cover top-level Web Agents or one-shot children; asynchronous durable attachment has a different lifecycle.

## Consequences

One optional plugin enables durable semantic records across Web creation, recovery, forks, and in-process subagents without changing unconfigured hosts. Ordinary fork and delegation lineage remain distinct. The integration adds small optional type edges to lifecycle owners, and out-of-process child runtimes must install their own persistence composition.
