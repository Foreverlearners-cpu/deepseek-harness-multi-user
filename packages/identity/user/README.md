# @deepseek-ai/dsh-user

English | [中文](README.zh.md)

User identity Service Definition for tenant-scoped runtimes. The package defines `ctx.users` and the stable user record vocabulary; a provider such as `@deepseek-ai/dsh-user-mysql` owns storage. Authentication credentials and external identity mappings remain separate capabilities.

## API

`ctx.users` creates, reads, disables, and lists users visible to the configured runtime. User ids are stable internal identifiers, not email addresses or request-supplied resource keys. A disabled user retains durable data but cannot start new work.

## Model Experience

### User identity service

#### What the model sees

Nothing. The service registers no tools, prompts, messages, or session events; trusted Host consumers use the `ctx.users` capability to authorize product operations.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: user records do not change the request prefix.

## Known Limitations and Deferred Work

- Authentication, password storage, external identity mappings, token revocation, and membership policy are separate work.
- The first provider is tenant-runtime scoped; request-level authenticated context will be added before a shared process serves mutually untrusted users.
