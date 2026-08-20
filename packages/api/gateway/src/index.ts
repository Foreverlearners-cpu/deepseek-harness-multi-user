/**
 * Live Typert Remote dispatch over Cordis Services and registered providers.
 * Transport, request correlation, and response envelopes belong to Connection.
 * @module @deepseek-ai/dsh-api-gateway
 */

import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { AuthenticationError, type AuthenticatedCall } from '@deepseek-ai/dsh-authentication'
import { AuthorizationDeniedError, permissionCode } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationAllowDecision, AuthorizationRequest } from '@deepseek-ai/dsh-authorization'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import {
  remoteMethods,
  TypertLookupFailure,
  type InvocationDescriptor,
  type InvocationParameterDescriptor,
  type TypertCodec,
  type TypertGatewayBinding,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  InvokeRemoteRequest,
  TypertGateway,
  TypertGatewayErrorCode,
} from './types.ts'

export type {
  InvokeRemoteRequest,
  TypertGateway,
  TypertGatewayErrorCode,
} from './types.ts'

interface GatewayErrorOptions {
  readonly cause?: unknown
  readonly field?: string
}

interface ResolvedBinding {
  readonly binding: TypertGatewayBinding
  readonly original: object
}

interface ResolvedInvocation {
  readonly descriptor: InvocationDescriptor
  readonly source:
    | { readonly kind: 'strict'; readonly revision: number }
    | { readonly kind: 'src' }
}

interface ResolvedReceiverContext {
  readonly context: Context
  readonly provider?: { readonly key: string; readonly revision: number }
}

interface ResolvedBusinessParameter {
  readonly value: unknown
  readonly provider?: { readonly key: string; readonly revision: number }
}

type ConnectionRpcResult = Awaited<ReturnType<ConnectionRpcHandler>>
type ConnectionRpcError = Extract<ConnectionRpcResult, { readonly ok: false }>['error']

/** Dispatch failure produced outside the invoked business method. */
export class TypertGatewayError extends Error {
  /** Machine-readable failure category. */
  readonly code: TypertGatewayErrorCode
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  readonly field: string | undefined

  /**
   * Construct a Gateway failure without embedding boundary values in its message.
   * @param code - stable failure category.
   * @param endpoint - canonical Remote endpoint.
   * @param message - correction-oriented diagnostic without sensitive values.
   * @param options - optional field and contained cause.
   */
  constructor(
    code: TypertGatewayErrorCode,
    endpoint: string,
    message: string,
    options: GatewayErrorOptions = {},
  ) {
    super(`typert gateway: ${endpoint}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TypertGatewayError'
    this.code = code
    this.endpoint = endpoint
    this.field = options.field
  }
}

/** Business invocation lost its carrier cancellation race. */
class RemoteInvocationCancelled extends Error {
  /**
   * @param endpoint - canonical Remote endpoint.
   * @param cause - business rejection observed after carrier cancellation.
   */
  constructor(endpoint: string, cause: unknown) {
    super(`Remote invocation "${endpoint}" was aborted`, { cause })
    this.name = 'RemoteInvocationCancelled'
  }
}

/**
 * Resolve strict generated definitions or conservative SRC markers against
 * current Cordis Services and Typert providers.
 * @typert service typertGateway
 */
export class TypertGatewayService extends Service implements TypertGateway {
  static inject = ['typert', 'authentication', 'authorization']

  private srcClaims: ReadonlySet<string> | undefined

  /**
   * Register the Gateway against the active Typert registry.
   * @param ctx - owning Host Context with Typert registry access.
   */
  constructor(ctx: Context) {
    super(ctx, 'typertGateway')
    ctx.on('internal/service', () => {
      this.srcClaims = undefined
    })
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.connection.rpc.intercept(
        '/api',
        endpoint => this.claimsEndpoint(endpoint),
        (endpoint, payload, call) => this.dispatchRpc(endpoint, payload, call),
        { authority: 'trusted-host' },
      )
    })
  }

  private claimsEndpoint(endpoint: string): boolean {
    const segments = endpoint.split('/')
    if (segments.length !== 2 || segments[0] === '' || segments[1] === '') return false
    if (this.ctx.typert.local.get(endpoint) !== undefined || this.ctx.typert.local.hasSeen(endpoint)) return true
    this.srcClaims ??= this.collectSrcClaims()
    return this.srcClaims.has(endpoint)
  }

  private collectSrcClaims(): ReadonlySet<string> {
    const claims = new Set<string>()
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver = this.ctx.get(serviceKey) as unknown
      if (!isObject(receiver)) continue
      const original = originalOf(receiver)
      const binding = Reflect.get(original, 'typertRemote') as unknown
      if (!isObject(binding) || typeof Reflect.get(binding, 'namespace') !== 'string') continue
      const namespace = Reflect.get(binding, 'namespace') as string
      for (const candidate of remoteMethods(original)) {
        claims.add(endpointOf(namespace, candidate.exportName ?? candidate.method))
      }
    }
    return claims
  }

  /**
   * Invoke one live Remote method through strict generated reflection or SRC markers.
   * @param request - decoded endpoint and exact named wire arguments.
   * @returns the validated business result.
   * @throws {@link AuthenticationError} for an invalid call.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures.
   * Lookup-policy and business errors retain identity.
   */
  async invoke(request: InvokeRemoteRequest): Promise<unknown> {
    assertAuthenticatedCall(this.ctx, request.call)
    const endpoint = endpointOf(request.namespace, request.method)
    const resolved = this.resolveDescriptor(request.namespace, request.method, endpoint)
    const { descriptor } = resolved
    validateDescriptorAccess(descriptor, endpoint)
    const rootReceiver = this.ctx.get(descriptor.service) as unknown
    if (!isObject(rootReceiver)) {
      throw new TypertGatewayError(
        'service-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} is unavailable`,
      )
    }
    validateBinding(rootReceiver, descriptor.service, descriptor.namespace, endpoint)
    validateRemoteAccess(rootReceiver, descriptor, endpoint)
    let authorizationRequest: AuthorizationRequest | undefined
    let authorizationDecision: AuthorizationAllowDecision | undefined
    if (descriptor.access === 'permission') {
      let permission
      try {
        permission = permissionCode(descriptor.authorization.permission)
      } catch (cause) {
        throw new TypertGatewayError(
          'signature-invalid',
          endpoint,
          'protected Remote descriptor has an invalid permission code',
          { cause },
        )
      }
      authorizationRequest = { call: request.call, permission }
      authorizationDecision = await this.ctx.authorization.require(authorizationRequest)
      // Lookup providers and receiver-context resolution are asynchronous.
      // Re-check the allow immediately after the policy gate so a credential
      // expiring or policy invalidation racing those steps cannot be consumed.
      this.ctx.authorization.assertCurrent(authorizationRequest, authorizationDecision)
    }
    assertExactArguments(request.args, descriptor, endpoint)
    const receiverResolution = await this.resolveReceiverContext(descriptor, request.args, endpoint)
    const receiverContext = receiverResolution.context
    const receiver = receiverContext.get(descriptor.service) as unknown
    if (!isObject(receiver)) {
      throw new TypertGatewayError(
        'service-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} is unavailable`,
      )
    }
    validateBinding(receiver, descriptor.service, descriptor.namespace, endpoint)
    validateRemoteAccess(receiver, descriptor, endpoint)
    const parameterResolutions = await Promise.all(descriptor.parameters.map(parameter =>
      this.resolveParameter(parameter, request.args, endpoint)))
    const businessArgs = parameterResolutions.map(resolution => resolution.value)
    this.assertResolutionCurrent(resolved, endpoint)
    if (receiverResolution.provider !== undefined
      && this.ctx.typert.contexts.hostRevision(receiverResolution.provider.key)
      !== receiverResolution.provider.revision) {
      throw new TypertGatewayError(
        'provider-mismatch',
        endpoint,
        `Context provider ${JSON.stringify(receiverResolution.provider.key)} changed while resolving the invocation`,
      )
    }
    for (const resolution of parameterResolutions) {
      if (resolution.provider !== undefined
        && this.ctx.typert.lookups.revision(resolution.provider.key) !== resolution.provider.revision) {
        throw new TypertGatewayError(
          'provider-mismatch',
          endpoint,
          `lookup provider ${JSON.stringify(resolution.provider.key)} changed while resolving the invocation`,
        )
      }
    }
    assertAuthenticatedCall(this.ctx, request.call)
    const currentReceiver = receiverContext.get(descriptor.service) as unknown
    if (!isObject(currentReceiver)
      || originalOf(currentReceiver) !== originalOf(receiver)
      || originalOf(currentReceiver) !== originalOf(rootReceiver)) {
      throw new TypertGatewayError(
        'service-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} changed while the invocation was pending`,
      )
    }
    validateBinding(currentReceiver, descriptor.service, descriptor.namespace, endpoint)
    validateRemoteAccess(currentReceiver, descriptor, endpoint)
    if (descriptor.access === 'permission') {
      // Argument lookup can suspend and policy changes can be committed while
      // it is running.  This is the final check directly before invocation;
      // the business method never receives a stale authorization decision.
      /* v8 ignore next -- descriptor.authorization always initialized together with the request above. */
      if (authorizationRequest === undefined || authorizationDecision === undefined) {
        throw new TypertGatewayError('binding-invalid', endpoint, 'protected Remote authorization state is missing')
      }
      this.ctx.authorization.assertCurrent(authorizationRequest, authorizationDecision)
    }
    const args: unknown[] = descriptor.access === 'authenticated'
      ? businessArgs
      : [request.call, ...businessArgs]
    const signal = request.call.signal
    if (descriptor.cancellation !== undefined) args.push(signal)
    const implementation = descriptor.implementation ?? descriptor.method
    const method = Reflect.get(currentReceiver, implementation) as unknown
    if (typeof method !== 'function') {
      throw new TypertGatewayError(
        'method-unavailable',
        endpoint,
        `active Service ${JSON.stringify(descriptor.service)} has no callable method ${JSON.stringify(implementation)}`,
      )
    }

    let result: unknown
    try {
      result = await Reflect.apply(method, currentReceiver, args) as unknown
    } catch (error) {
      if (signal.aborted) throw new RemoteInvocationCancelled(endpoint, error)
      throw error
    }
    // A weak descriptor declares no return type, so nothing returned is a void
    // result and rides the wire as an absent value field. A strict descriptor
    // keeps its schema: there, undefined has to be a declared result.
    if (result === undefined && descriptor.result.mode !== 'strict') return result
    return decode(descriptor.result, result, 'result-invalid', endpoint, 'result')
  }

  private async dispatchRpc(
    endpoint: string,
    payload: unknown,
    call: AuthenticatedCall,
  ): Promise<ConnectionRpcResult> {
    return this.invokeRpc(endpoint, payload, call)
  }

  private async invokeRpc(endpoint: string, payload: unknown, call: AuthenticatedCall): Promise<ConnectionRpcResult> {
    try {
      const segments = endpoint.split('/')
      if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
        throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`)
      }
      const [namespace, method] = segments as [string, string]
      if (!isObject(payload)
        || !isPlainObject(payload)
        || Reflect.ownKeys(payload).length !== 1
        || !Object.hasOwn(payload, 'args')
        || !isObject(payload.args)
        || !isPlainObject(payload.args)) {
        throw new Error('Remote payload must contain exactly one plain-object args field')
      }
      const value = await this.invoke({
        call,
        namespace,
        method,
        args: payload.args,
      })
      // A void or explicitly absent business result carries no `value` field;
      // JSON has no `undefined`, and the envelope's optional slot is the one
      // representation of absence that both args and results already use.
      return { ok: true, value }
    } catch (error) {
      return rpcFailure(error)
    }
  }

  private resolveDescriptor(namespace: string, method: string, endpoint: string): ResolvedInvocation {
    const strict = this.ctx.typert.local.get(endpoint)
    if (strict !== undefined) {
      return {
        descriptor: strict,
        source: { kind: 'strict', revision: this.ctx.typert.local.revision(endpoint) },
      }
    }
    if (this.ctx.typert.local.hasSeen(endpoint)) {
      throw new TypertGatewayError(
        'definition-unavailable',
        endpoint,
        'its strict definition was withdrawn and SRC fallback is forbidden',
      )
    }
    return { descriptor: this.resolveSrcDescriptor(namespace, method, endpoint), source: { kind: 'src' } }
  }

  private assertResolutionCurrent(resolved: ResolvedInvocation, endpoint: string): void {
    if (resolved.source.kind === 'strict') {
      if (this.ctx.typert.local.revision(endpoint) === resolved.source.revision
        && this.ctx.typert.local.get(endpoint) === resolved.descriptor) return
      throw new TypertGatewayError(
        'definition-unavailable',
        endpoint,
        'its strict definition changed while the invocation was pending',
      )
    }
    if (this.ctx.typert.local.get(endpoint) !== undefined || this.ctx.typert.local.hasSeen(endpoint)) {
      throw new TypertGatewayError(
        'definition-unavailable',
        endpoint,
        'its definition source changed while the invocation was pending',
      )
    }
    const current = this.resolveSrcDescriptor(
      resolved.descriptor.namespace,
      resolved.descriptor.method,
      endpoint,
    )
    if (JSON.stringify(current) === JSON.stringify(resolved.descriptor)) return
    throw new TypertGatewayError(
      'definition-unavailable',
      endpoint,
      'its SRC definition changed while the invocation was pending',
    )
  }

  private resolveSrcDescriptor(namespace: string, method: string, endpoint: string): InvocationDescriptor {
    const candidates: InvocationDescriptor[] = []
    for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
      if (definition.type !== 'service') continue
      const receiver = this.ctx.get(serviceKey) as unknown
      if (!isObject(receiver)) continue
      const original = originalOf(receiver)
      const value = Reflect.get(original, 'typertRemote') as unknown
      if (value === undefined) continue
      const binding = readBinding(value, original, serviceKey, endpoint)
      if (binding.namespace !== namespace) continue
      const marker = remoteMethods(original).find(candidate => (candidate.exportName ?? candidate.method) === method)
      if (marker === undefined) continue
      candidates.push(this.srcDescriptor(binding, marker, method, endpoint))
    }
    if (candidates.length === 0) {
      throw new TypertGatewayError('invocation-unavailable', endpoint, 'no active Remote method exports this endpoint')
    }
    if (candidates.length > 1) {
      throw new TypertGatewayError(
        'ambiguous-endpoint',
        endpoint,
        `multiple active Services export this endpoint: ${candidates.map(candidate => candidate.service).sort().join(', ')}`,
      )
    }
    return candidates[0] as InvocationDescriptor
  }

  private srcDescriptor(
    binding: TypertGatewayBinding,
    marker: ReturnType<typeof remoteMethods>[number],
    method: string,
    endpoint: string,
  ): InvocationDescriptor {
    let names = methodParameterNames(binding.service, marker.method, endpoint)
    if (marker.access === 'permission') {
      if (names[0] !== marker.authorization.callParameter) {
        throw new TypertGatewayError(
          'signature-invalid',
          endpoint,
          'protected SRC Remote must declare call as its first parameter',
          { field: marker.authorization.callParameter },
        )
      }
      names = names.slice(1)
    }
    const signalIndex = names.indexOf('signal')
    if (signalIndex >= 0 && signalIndex !== names.length - 1) {
      throw new TypertGatewayError(
        'signature-invalid',
        endpoint,
        'SRC cancellation parameter signal must be the final parameter',
        { field: 'signal' },
      )
    }
    const cancellation = signalIndex >= 0
      ? { parameter: 'signal' as const }
      : undefined
    const businessNames = cancellation === undefined ? names : names.slice(0, -1)
    const parameters: InvocationParameterDescriptor[] = []
    const wires = new Set<string>()
    for (const name of businessNames) {
      const matches = this.ctx.typert.lookups.definitions()
        .filter(definition => definition.parameter === name)
      if (matches.length > 1) {
        throw new TypertGatewayError(
          'signature-invalid',
          endpoint,
          `parameter ${JSON.stringify(name)} matches multiple lookup providers`,
          { field: name },
        )
      }
      const match = matches[0]
      const parameter: InvocationParameterDescriptor = match === undefined
        ? { name, wire: name, source: 'json', codec: { mode: 'src-json' } }
        : {
          name,
          wire: match.wire,
          source: 'lookup',
          lookup: match.key,
          codec: { mode: 'src-json' },
        }
      if (wires.has(parameter.wire)) {
        throw new TypertGatewayError(
          'signature-invalid',
          endpoint,
          `multiple parameters use wire field ${JSON.stringify(parameter.wire)}`,
          { field: parameter.wire },
        )
      }
      wires.add(parameter.wire)
      parameters.push(parameter)
    }

    let receiver: InvocationDescriptor['invocation'] = { kind: 'direct' }
    if (marker.invocation.kind === 'context') {
      const provider = this.ctx.typert.contexts.getHost(marker.invocation.context)
      if (provider === undefined) {
        throw new TypertGatewayError(
          'context-unavailable',
          endpoint,
          `Context provider ${JSON.stringify(marker.invocation.context)} is unavailable`,
        )
      }
      if (wires.has(provider.wire)) {
        throw new TypertGatewayError(
          'signature-invalid',
          endpoint,
          `Context identity conflicts with wire field ${JSON.stringify(provider.wire)}`,
          { field: provider.wire },
        )
      }
      receiver = {
        kind: 'context',
        context: marker.invocation.context,
        wire: provider.wire,
        codec: { mode: 'src-json' },
      }
    }

    const base: Omit<InvocationDescriptor, 'access' | 'authorization'> = {
      id: `src:${binding.serviceKey}#${endpoint}`,
      service: binding.serviceKey,
      namespace: binding.namespace,
      method,
      ...(marker.method === method ? {} : { implementation: marker.method }),
      invocation: receiver,
      parameters,
      ...(cancellation === undefined ? {} : { cancellation }),
      result: { mode: 'src-json' },
    }
    return marker.access === 'authenticated'
      ? { ...base, access: 'authenticated' }
      : { ...base, access: 'permission', authorization: marker.authorization }
  }

  private async resolveReceiverContext(
    descriptor: InvocationDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<ResolvedReceiverContext> {
    if (descriptor.invocation.kind === 'direct') return { context: this.ctx }
    const invocation = descriptor.invocation
    const revision = this.ctx.typert.contexts.hostRevision(invocation.context)
    const provider = this.ctx.typert.contexts.getHost(invocation.context)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'context-unavailable',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} is unavailable`,
      )
    }
    if (provider.wire !== invocation.wire
      || (invocation.codec.mode === 'strict' && provider.wireTypeSymbol !== invocation.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'provider-mismatch',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} does not match its strict definition`,
        { field: invocation.wire },
      )
    }
    const identity = decode(invocation.codec, args[invocation.wire], 'input-invalid', endpoint, invocation.wire)
    let context: Context | undefined
    try {
      context = await provider.resolve(identity)
    } catch (cause) {
      if (cause instanceof TypertLookupFailure) throw cause
      throw new TypertGatewayError(
        'context-failed',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} failed`,
        { cause, field: invocation.wire },
      )
    }
    if (context === undefined) {
      throw new TypertGatewayError(
        'context-not-found',
        endpoint,
        `Context provider ${JSON.stringify(invocation.context)} did not resolve the requested identity`,
        { field: invocation.wire },
      )
    }
    return { context, provider: { key: invocation.context, revision } }
  }

  private async resolveParameter(
    parameter: InvocationParameterDescriptor,
    args: Readonly<Record<string, unknown>>,
    endpoint: string,
  ): Promise<ResolvedBusinessParameter> {
    // An absent field reached assertExactArguments' allowance, so this parameter
    // takes undefined; a present-but-undefined field is not JSON-safe input and
    // still fails decode. Lookup ids are never omissible, so absence here only
    // ever belongs to a json parameter.
    if (!Object.hasOwn(args, parameter.wire)) return { value: undefined }
    const value = decode(parameter.codec, args[parameter.wire], 'input-invalid', endpoint, parameter.wire)
    if (parameter.source === 'json') return { value }
    const key = parameter.lookup
    /* v8 ignore next -- registry validation rejects strict descriptors without a key, and SRC derivation always supplies one. */
    if (key === undefined) {
      throw new TypertGatewayError(
        'lookup-unavailable',
        endpoint,
        `lookup parameter ${JSON.stringify(parameter.name)} has no provider key`,
        { field: parameter.wire },
      )
    }
    const revision = this.ctx.typert.lookups.revision(key)
    const provider = this.ctx.typert.lookups.get(key)
    if (provider === undefined) {
      throw new TypertGatewayError(
        'lookup-unavailable',
        endpoint,
        `lookup provider ${JSON.stringify(key)} is unavailable`,
        { field: parameter.wire },
      )
    }
    if (provider.wire !== parameter.wire
      || (parameter.codec.mode === 'strict' && provider.wireTypeSymbol !== parameter.codec.typeSymbol)) {
      throw new TypertGatewayError(
        'provider-mismatch',
        endpoint,
        `lookup provider ${JSON.stringify(key)} does not match its strict definition`,
        { field: parameter.wire },
      )
    }
    let resolved: unknown
    try {
      resolved = await provider.resolve(value)
    } catch (cause) {
      if (cause instanceof TypertLookupFailure) throw cause
      throw new TypertGatewayError(
        'lookup-failed',
        endpoint,
        `lookup provider ${JSON.stringify(key)} failed`,
        { cause, field: parameter.wire },
      )
    }
    if (resolved === undefined) {
      throw new TypertGatewayError(
        'lookup-not-found',
        endpoint,
        `lookup provider ${JSON.stringify(key)} did not resolve the requested identity`,
        { field: parameter.wire },
      )
    }
    return { value: resolved, provider: { key, revision } }
  }
}

function rpcFailure(error: unknown): ConnectionRpcResult {
  if (error instanceof RemoteInvocationCancelled) {
    return {
      ok: false,
      error: { code: 'cancelled', message: error.message, details: {} },
    }
  }
  if (error instanceof TypertLookupFailure) {
    return { ok: false, error: error.failure as ConnectionRpcError }
  }
  if (error instanceof AuthorizationDeniedError) {
    return {
      ok: false,
      error: error.publicError.code === 'UNAUTHENTICATED'
        ? { code: 'unauthenticated', message: error.message, details: {} }
        : {
          code: 'permission-denied',
          message: error.message,
          details: { permission: error.permission },
        },
    }
  }
  if (error instanceof AuthenticationError) {
    return {
      ok: false,
      error: { code: 'unauthenticated', message: error.message, details: {} },
    }
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: 'handler failure',
      details: {},
    },
  }
}

function assertAuthenticatedCall(ctx: Context, call: AuthenticatedCall): void {
  const authentication = ctx.get('authentication')
  if (authentication === undefined || !authentication.owns(call)) {
    throw new AuthenticationError('unauthenticated', 'authenticated call is invalid')
  }
  if (call.expiresAt !== undefined && call.expiresAt <= Date.now()) {
    throw new AuthenticationError('unauthenticated', 'authenticated call has expired')
  }
}

function validateDescriptorAccess(descriptor: InvocationDescriptor, endpoint: string): void {
  if (!Object.hasOwn(descriptor, 'access')) {
    throw new TypertGatewayError('signature-invalid', endpoint, 'Remote descriptor access must be authenticated or permission')
  }
  const access = (descriptor as { readonly access?: unknown }).access
  const authorization = Object.hasOwn(descriptor, 'authorization')
    ? (descriptor as { readonly authorization?: unknown }).authorization
    : undefined
  if (access === 'authenticated') {
    if (authorization === undefined) return
    throw new TypertGatewayError(
      'signature-invalid',
      endpoint,
      'authenticated Remote descriptor must not declare authorization',
    )
  }
  if (access === 'permission') {
    if (typeof authorization === 'object'
      && authorization !== null
      && Object.hasOwn(authorization, 'permission')
      && Object.hasOwn(authorization, 'callParameter')
      && typeof Reflect.get(authorization, 'permission') === 'string'
      && (Reflect.get(authorization, 'permission') as string).trim().length > 0
      && Reflect.get(authorization, 'callParameter') === 'call') return
    throw new TypertGatewayError(
      'signature-invalid',
      endpoint,
      'permission Remote descriptor requires valid authorization metadata',
    )
  }
  throw new TypertGatewayError(
    'signature-invalid',
    endpoint,
    'Remote descriptor access must be authenticated or permission',
  )
}

function validateRemoteAccess(
  receiver: object,
  descriptor: InvocationDescriptor,
  endpoint: string,
): void {
  const original = originalOf(receiver)
  const implementation = descriptor.implementation ?? descriptor.method
  const marker = remoteMethods(original).find(candidate =>
    candidate.method === implementation
    && (candidate.exportName ?? candidate.method) === descriptor.method)
  const invocationMatches = marker !== undefined
    && marker.invocation.kind === descriptor.invocation.kind
    && (marker.invocation.kind === 'direct'
      || (descriptor.invocation.kind === 'context'
        && marker.invocation.context === descriptor.invocation.context))
  if (!invocationMatches) {
    throw new TypertGatewayError(
      'binding-invalid',
      endpoint,
      'live Remote invocation does not match its invocation descriptor',
    )
  }
  if (marker.access === 'authenticated' && descriptor.access === 'authenticated') return
  if (marker.access === 'permission'
    && descriptor.access === 'permission'
    && marker.authorization.permission === descriptor.authorization.permission
    && (marker.authorization as { readonly callParameter?: unknown }).callParameter
      === (descriptor.authorization as { readonly callParameter?: unknown }).callParameter) return
  throw new TypertGatewayError(
    'binding-invalid',
    endpoint,
    'live Remote access does not match its invocation descriptor',
  )
}

function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`
}

function validateBinding(
  receiver: object,
  serviceKey: string,
  namespace: string,
  endpoint: string,
): ResolvedBinding {
  const original = originalOf(receiver)
  const value = Reflect.get(original, 'typertRemote') as unknown
  if (value === undefined) {
    throw new TypertGatewayError(
      'binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has no visible typertRemote binding`,
    )
  }
  return {
    binding: readBinding(value, original, serviceKey, endpoint, namespace),
    original,
  }
}

function readBinding(
  value: unknown,
  original: object,
  serviceKey: string,
  endpoint: string,
  namespace?: string,
): TypertGatewayBinding {
  if (!isObject(value)
    || Reflect.get(value, 'service') !== original
    || Reflect.get(value, 'serviceKey') !== serviceKey
    || typeof Reflect.get(value, 'namespace') !== 'string'
    || (namespace !== undefined && Reflect.get(value, 'namespace') !== namespace)) {
    throw new TypertGatewayError(
      'binding-invalid',
      endpoint,
      `Service ${JSON.stringify(serviceKey)} has an inconsistent typertRemote binding`,
    )
  }
  return value as unknown as TypertGatewayBinding
}

function originalOf(receiver: object): object {
  const original = Reflect.get(receiver, symbols.original) as unknown
  return isObject(original) ? original : receiver
}

function methodParameterNames(service: object, method: string, endpoint: string): readonly string[] {
  let prototype: object | null = Object.getPrototypeOf(service) as object | null
  let implementation: ((this: object, ...args: never[]) => unknown) | undefined
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    if (descriptor !== undefined) {
      if ('value' in descriptor && typeof descriptor.value === 'function') {
        implementation = descriptor.value as (this: object, ...args: never[]) => unknown
      }
      break
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  if (implementation === undefined) {
    throw new TypertGatewayError(
      'method-unavailable',
      endpoint,
      `Remote marker has no prototype method ${JSON.stringify(method)}`,
    )
  }
  const source = Function.prototype.toString.call(implementation)
  const open = source.indexOf('(')
  const close = source.indexOf(')', open + 1)
  /* v8 ignore next -- standard public class-method syntax always contains a parenthesized parameter list. */
  if (open < 0 || close < 0) return invalidSignature(endpoint, method)
  const body = source.slice(open + 1, close).trim()
  if (body.length === 0) return []
  const parts = body.split(',').map(part => part.trim())
  const names = new Set<string>()
  for (const part of parts) {
    if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return invalidSignature(endpoint, method)
    names.add(part)
  }
  return [...names]
}

function invalidSignature(endpoint: string, method: string): never {
  throw new TypertGatewayError(
    'signature-invalid',
    endpoint,
    `SRC method ${JSON.stringify(method)} must use unique identifier parameters without destructuring, defaults, or rest`,
  )
}

function assertExactArguments(
  args: Readonly<Record<string, unknown>>,
  descriptor: InvocationDescriptor,
  endpoint: string,
): void {
  if (!isPlainObject(args)) {
    throw new TypertGatewayError('arguments-invalid', endpoint, 'args must be a plain object')
  }
  const expected = new Set(descriptor.parameters.map(parameter => parameter.wire))
  if (descriptor.invocation.kind === 'context') expected.add(descriptor.invocation.wire)
  const actual = Reflect.ownKeys(args)
  const extra = actual.filter(key => typeof key !== 'string' || !expected.has(key))
  // A JSON field may be omitted when the strict descriptor declares absence,
  // and always under SRC: a weak descriptor reads parameter names from the
  // JavaScript signature and cannot see which are optional, so LIB is where an
  // omitted required argument is caught. Lookup ids are never omissible.
  const acceptsMissing = new Set(descriptor.parameters
    .filter(parameter => parameter.source === 'json'
      && (parameter.acceptsUndefined === true || parameter.codec.mode === 'src-json'))
    .map(parameter => parameter.wire))
  const missing = [...expected].filter(key => !Object.hasOwn(args, key) && !acceptsMissing.has(key))
  if (extra.length === 0 && missing.length === 0) return
  const clauses: string[] = []
  if (missing.length > 0) clauses.push(`missing ${missing.map(key => JSON.stringify(key)).join(', ')}`)
  if (extra.length > 0) clauses.push(`unexpected ${extra.map(key => JSON.stringify(String(key))).join(', ')}`)
  throw new TypertGatewayError('arguments-invalid', endpoint, `args fields do not match the descriptor: ${clauses.join('; ')}`)
}

function decode(
  codec: TypertCodec,
  value: unknown,
  code: 'input-invalid' | 'result-invalid',
  endpoint: string,
  field: string,
): unknown {
  try {
    if (codec.mode === 'strict') {
      value = codec.schema.parse(value)
      if (value === undefined) return value
    }
    assertJsonValue(value, new Set())
    return value
  } catch (cause) {
    throw new TypertGatewayError(
      code,
      endpoint,
      code === 'input-invalid'
        ? `wire field ${JSON.stringify(field)} failed boundary validation`
        : 'business result failed boundary validation',
      { cause, field },
    )
  }
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError('non-finite number is not JSON-safe')
  }
  if (!isObject(value)) throw new TypeError(`${typeof value} is not JSON-safe`)
  if (ancestors.has(value)) throw new TypeError('cyclic value is not JSON-safe')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
        throw new TypeError('sparse or decorated array is not JSON-safe')
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array is not JSON-safe')
        assertJsonValue(value[index], ancestors)
      }
      return
    }
    if (!isPlainObject(value)) throw new TypeError('non-plain object is not JSON-safe')
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('symbol property is not JSON-safe')
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      /* v8 ignore next -- ownKeys() just returned this key; only a hostile same-process Proxy can delete it between operations. */
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('non-data property is not JSON-safe')
      }
      assertJsonValue(descriptor.value, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  if (Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || prototype === Object.prototype
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

export default TypertGatewayService
