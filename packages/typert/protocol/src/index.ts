/**
 * Remote decorators and explicit Gateway bindings backed only by private
 * module state. Strict reflection remains a Typert compiler responsibility.
 * @module @deepseek-ai/dsh-typert-protocol
 */

import { Service, symbols, type Context } from '@deepseek-ai/cordis'
import type { TypertContextMap } from './types.ts'

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Test one generated Remote name against the Connection endpoint grammar.
 * @param value - namespace, method, lookup, or Context segment.
 * @returns whether the value can cross the shared RPC carrier unchanged.
 */
export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value)
}

/**
 * A lookup policy rejection whose typed payload belongs to the active boundary adapter.
 * Gateway adapters preserve this payload instead of collapsing it into an infrastructure failure.
 */
export class TypertLookupFailure<Failure = unknown> extends Error {
  /** Adapter-owned failure returned to the caller. */
  readonly failure: Failure

  /**
   * Wrap one adapter failure without exposing the rejected identity.
   * @param failure - typed failure owned by the active boundary adapter.
   */
  constructor(failure: Failure) {
    super('Typert lookup policy rejected the requested identity')
    this.name = 'TypertLookupFailure'
    this.failure = failure
  }
}

export type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  InvocationSourceLocation,
  RemoteFailure,
  RemoteResult,
  TypertClientRemote,
  TypertClientContextBinder,
  TypertCodec,
  TypertContext,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertForwardableEvent,
  TypertHostContextProvider,
  TypertHostContextResolver,
  TypertLocalRegistry,
  TypertLookup,
  TypertLookupDefinition,
  TypertLookupHost,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteScopeApi,
  TypertRemoteScopeMap,
  TypertRemoteScopeNamespace,
  TypertRemoteContribution,
  TypertRemoteEvent,
  TypertRemoteEventSelection,
  TypertRemoteMap,
  TypertRemoteNamespace,
  TypertRemoteNamespaceMap,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertSchema,
  TypertRegistryContract,
} from './types.ts'

/** Options for an explicit Service-to-Gateway binding. */
export interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string
}

/** Visible declaration that one Service participates in Typert Gateway export. */
export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}

/** Invocation mode recorded by a Remote method decorator. */
export type RemoteInvocationMarker =
  | { readonly kind: 'direct' }
  | { readonly kind: 'context'; readonly context: string }

/** Host-only authorization injected before protected Remote business arguments. */
export interface RemoteAuthorizationMarker {
  /** Product permission required before dispatch. */
  readonly permission: string
  /** Reserved first Host method parameter; never represented on the wire. */
  readonly callParameter: 'call'
}

/** Options for one Remote available to every authenticated caller. */
export interface AuthenticatedRemoteOptions {
  /** Require a valid Host-issued call without checking a product permission. */
  readonly access: 'authenticated'
  readonly permission?: never
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
}

/** Options for one permission-protected Remote method. */
export interface PermissionRemoteOptions {
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
  /** Product permission checked before argument validation or business lookup. */
  readonly permission: string
  readonly access?: never
}

/** Explicit access declaration required by every Remote method. */
export type RemoteOptions = AuthenticatedRemoteOptions | PermissionRemoteOptions

interface RemoteMethodMarkerBase {
  /** Public instance method carrying the implementation. */
  readonly method: string
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
}

/** One decorator marker discovered for a live Service instance. */
export type RemoteMethodMarker =
  | RemoteMethodMarkerBase & {
    /** A valid authenticated call is sufficient. */
    readonly access: 'authenticated'
    readonly authorization?: never
  }
  | RemoteMethodMarkerBase & {
    /** Product authorization is required before dispatch. */
    readonly access: 'permission'
    /** Host-only authorization metadata for a protected method. */
    readonly authorization: RemoteAuthorizationMarker
  }

type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

interface RemoteInitializerContext<This extends object> {
  readonly private: boolean
  readonly static: boolean
  readonly name: string | symbol
  addInitializer(initializer: (this: This) => void): void
}

type StoredRemoteMethodMarker = {
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
  readonly implementation: object
} & (
  | { readonly access: 'authenticated'; readonly authorization?: never }
  | { readonly access: 'permission'; readonly authorization: RemoteAuthorizationMarker }
)

const markers = new WeakMap<object, Map<string, StoredRemoteMethodMarker>>()

/**
 * Bind one visible Service field to a Cordis key and Remote namespace.
 * @param service - owning Service instance, normally `this`.
 * @param serviceKey - exact Cordis service key.
 * @param options - optional distinct wire namespace.
 * @returns a frozen, inspectable binding with no compiler-injected metadata.
 */
export function bindTypertRemote<Service extends object>(
  service: Service,
  serviceKey: string,
  options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey
  validateName('namespace', namespace)
  return Object.freeze({ service, serviceKey, namespace })
}

/** Cordis Service base that exposes its registered name through Typert Gateway. */
export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional distinct wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

/**
 * Mark one direct Remote with an explicit authenticated or permission access level.
 * @param options - access declaration and optional endpoint method.
 * @returns a standard method decorator.
 */
export function Remote(options: RemoteOptions): RemoteMethodDecorator {
  const normalized = normalizeRemoteOptions(options)
  return function <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, method, { kind: 'direct' }, normalized)
  }
}

/**
 * Create a decorator for a method resolved from one Remote Scope.
 * @param key - scope key declared through the Context map.
 * @param options - access declaration and optional endpoint method.
 * @returns a standard method decorator that records only private module state.
 */
export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  options: RemoteOptions,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  const normalized = normalizeRemoteOptions(options)
  return function <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void {
    addMarkerInitializer(context, method, { kind: 'context', context: key }, normalized)
  }
}

/**
 * Read Remote markers attached to a live Service by decorator initializers.
 * The returned snapshot cannot mutate the private marker table.
 * @param service - live Service instance.
 * @returns markers in class declaration order.
 */
export function remoteMethods(service: object): readonly RemoteMethodMarker[] {
  const wrapped = Reflect.get(service, symbols.original) as unknown
  const original = (typeof wrapped === 'object' && wrapped !== null) || typeof wrapped === 'function'
    ? wrapped
    : service
  const prototype = Object.getPrototypeOf(original) as object | null
  if (prototype === null) return []
  const result: RemoteMethodMarker[] = []
  for (const [method, marker] of markers.get(prototype) ?? []) {
    if (Reflect.get(original, method) !== marker.implementation) continue
    if (marker.access === 'authenticated') {
      result.push({
        method,
        ...(marker.exportName === undefined ? {} : { exportName: marker.exportName }),
        invocation: marker.invocation,
        access: 'authenticated',
      })
    } else {
      result.push({
        method,
        ...(marker.exportName === undefined ? {} : { exportName: marker.exportName }),
        invocation: marker.invocation,
        access: 'permission',
        authorization: marker.authorization,
      })
    }
  }
  return result
}

function addMarkerInitializer<This extends object>(
  context: RemoteInitializerContext<This>,
  implementation: object,
  invocation: RemoteInvocationMarker,
  options: NormalizedRemoteOptions,
): void {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const method = context.name
  context.addInitializer(function (this: This) {
    const prototype = Object.getPrototypeOf(this) as object | null
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`)
    }
    if (Reflect.get(prototype, method) !== implementation) return
    mark(prototype, method, implementation, invocation, options)
  })
}

function mark(
  prototype: object,
  method: string,
  implementation: object,
  invocation: RemoteInvocationMarker,
  options: NormalizedRemoteOptions,
): void {
  let table = markers.get(prototype)
  if (table === undefined) {
    table = new Map()
    markers.set(prototype, table)
  }
  const marker: StoredRemoteMethodMarker = options.access === 'authenticated'
    ? {
      ...(options.exportName === undefined || options.exportName === method ? {} : { exportName: options.exportName }),
      invocation: Object.freeze(invocation),
      implementation,
      access: 'authenticated',
    }
    : {
      ...(options.exportName === undefined || options.exportName === method ? {} : { exportName: options.exportName }),
      invocation: Object.freeze(invocation),
      implementation,
      access: 'permission',
      authorization: options.authorization,
    }
  const current = table.get(method)
  if (current !== undefined) {
    if (current.exportName === marker.exportName
      && current.implementation === implementation
      && sameInvocation(current.invocation, invocation)
      && sameAccess(current, marker)) return
    throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`)
  }
  table.set(method, Object.freeze(marker))
}

type NormalizedRemoteOptions =
  | { readonly exportName?: string; readonly access: 'authenticated' }
  | {
    readonly exportName?: string
    readonly access: 'permission'
    readonly authorization: RemoteAuthorizationMarker
  }

const REMOTE_OPTION_NAMES = ['access', 'exportName', 'permission'] as const

function normalizeRemoteOptions(options: unknown): NormalizedRemoteOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('typert-protocol: Remote options must be an object')
  }
  const keys = Reflect.ownKeys(options)
  const descriptors = new Map<PropertyKey, PropertyDescriptor>()
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('typert-protocol: Remote options must use own data properties')
    }
    descriptors.set(key, descriptor)
  }
  rejectInheritedRemoteOptions(options, descriptors)
  const exportName = descriptors.get('exportName')?.value as unknown
  if (exportName !== undefined) {
    if (typeof exportName !== 'string') throw new TypeError('typert-protocol: Remote export name must be a string')
    validateName('Remote export name', exportName)
  }
  if (descriptors.has('permission')) {
    if (keys.some(key => key !== 'exportName' && key !== 'permission')) {
      throw new TypeError('typert-protocol: Remote permission options support only exportName and permission')
    }
    const permission = descriptors.get('permission')?.value as unknown
    if (typeof permission !== 'string' || permission.trim().length === 0) {
      throw new TypeError('typert-protocol: Remote permission must be a nonempty string')
    }
    return {
      ...(exportName === undefined ? {} : { exportName }),
      access: 'permission',
      authorization: Object.freeze({ permission, callParameter: 'call' }),
    }
  }
  if (keys.some(key => key !== 'exportName' && key !== 'access')) {
    throw new TypeError('typert-protocol: Remote authenticated options support only access and exportName')
  }
  if (descriptors.get('access')?.value !== 'authenticated') {
    throw new TypeError('typert-protocol: Remote options require access "authenticated" or a nonempty permission')
  }
  return { ...(exportName === undefined ? {} : { exportName }), access: 'authenticated' }
}

function rejectInheritedRemoteOptions(
  options: object,
  descriptors: ReadonlyMap<PropertyKey, PropertyDescriptor>,
): void {
  let prototype = Reflect.getPrototypeOf(options)
  while (prototype !== null) {
    for (const name of REMOTE_OPTION_NAMES) {
      if (!descriptors.has(name) && Reflect.getOwnPropertyDescriptor(prototype, name) !== undefined) {
        throw new TypeError('typert-protocol: Remote options must use own data properties')
      }
    }
    prototype = Reflect.getPrototypeOf(prototype)
  }
}

function sameAccess(left: StoredRemoteMethodMarker, right: StoredRemoteMethodMarker): boolean {
  return left.access === right.access
    && (left.access === 'authenticated'
      || (right.access === 'permission'
        && left.authorization.permission === right.authorization.permission))
}

function sameInvocation(left: RemoteInvocationMarker, right: RemoteInvocationMarker): boolean {
  return left.kind === right.kind
    && (left.kind === 'direct' || (right.kind === 'context' && left.context === right.context))
}

function validateName(subject: string, value: string): void {
  if (!isTypertRemoteSegment(value)) {
    throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`)
  }
}
