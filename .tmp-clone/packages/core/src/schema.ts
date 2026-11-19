/**
 * A dependency-free schema builder.
 *
 * ## Why this file exists
 *
 * The configuration schema used to be built with the Host's schema library. It
 * was the plugin's only runtime dependency, and it was there for one reason: the
 * Host's settings surface read that exact object to render its form. A
 * standalone product has no such surface, so the object is now only a *record*
 * of the shape — the values themselves are normalised and range-checked by
 * `resolveConfig()` in `config.ts`, which was always the real validation layer.
 *
 * So this module deliberately does **not** validate. It collects a description:
 * type, members, default, bounds, role and volatility. Re-implementing a
 * validator would create a second source of truth next to `resolveConfig`, and
 * the two would drift — the failure mode being a field the form refuses to save
 * while the runtime silently accepts it.
 *
 * ## Shape
 *
 * The surface is the small subset `config.ts` actually uses, chainable in any
 * order, every modifier returning `this`:
 *
 * ```ts
 * z.object({ enabled: z.boolean().default(true).volatile() })
 * z.number().min(0).max(200).default(50)
 * z.union([z.const('strict'), z.const('standard')]).default('standard')
 * z.string().role('secret').default('')
 * ```
 *
 * Anything beyond that subset is intentionally absent: an unused feature is an
 * untested one, and this file has to stay small enough to read in one sitting.
 */

/** The kinds a schema node can be. */
export type SchemaType = 'object' | 'string' | 'number' | 'boolean' | 'const' | 'union'

/** One schema node: a description of a value, never a validator. */
export class Schema<T = unknown> {
  /** What kind of value this node describes. */
  readonly type: SchemaType

  /** Field map, for `object()` nodes. `undefined` for every other kind. */
  readonly shape: Readonly<Record<string, Schema>> | undefined

  /** The one permitted value, for `const()` nodes. */
  readonly literal: unknown

  /** Permitted alternatives, for `union()` nodes. */
  readonly options: readonly Schema[]

  /** Whether `.default()` was called, so a missing default is not read as `undefined`. */
  hasDefault = false

  /** The recorded default, when {@link hasDefault}. */
  defaultValue: unknown = undefined

  /** Inclusive lower bound, when `.min()` was called. */
  minimum: number | undefined = undefined

  /** Inclusive upper bound, when `.max()` was called. */
  maximum: number | undefined = undefined

  /**
   * What the value *is*, for surfaces that must not echo it.
   *
   * `secret` is the only role in use: it marks a field whose value must never be
   * rendered back to a browser, only reported as "configured, length N".
   *
   * Stored under a distinct name because `role()` is also a method — a field and
   * a method cannot share one identifier on a class.
   */
  roleName: string | undefined = undefined

  /**
   * Whether a change takes effect without a remount.
   *
   * Every field of this product's config is volatile: the runtime re-reads the
   * resolved config per request, so there is nothing to remount. The flag is
   * kept because it is what the settings form keys off to save on blur rather
   * than on submit.
   */
  isVolatile = false

  constructor(
    type: SchemaType,
    parts: {
      readonly shape?: Readonly<Record<string, Schema>>
      readonly literal?: unknown
      readonly options?: readonly Schema[]
    } = {},
  ) {
    this.type = type
    this.shape = parts.shape
    this.literal = parts.literal
    this.options = parts.options ?? []
  }

  /** Record the value used when the document omits this field. */
  default(value: T): this {
    this.hasDefault = true
    this.defaultValue = value
    return this
  }

  /** Record an inclusive lower bound. */
  min(value: number): this {
    this.minimum = value
    return this
  }

  /** Record an inclusive upper bound. */
  max(value: number): this {
    this.maximum = value
    return this
  }

  /** Record what the value is, for redaction. */
  role(value: string): this {
    this.roleName = value
    return this
  }

  /** Mark the field as taking effect without a remount. */
  volatile(): this {
    this.isVolatile = true
    return this
  }
}

/** Build a schema node without touching the class from the call site. */
function node(type: SchemaType, parts: ConstructorParameters<typeof Schema>[1] = {}): Schema {
  return new Schema(type, parts)
}

/**
 * The builder, shaped like the library it replaces.
 *
 * Exported as the default so `config.ts` reads exactly as it did before — the
 * point of the swap is that no field definition had to move or be restated.
 */
const z = {
  /** An object with named fields. */
  object(shape: Record<string, Schema>): Schema {
    return node('object', { shape })
  },
  /** A string. */
  string(): Schema<string> {
    return new Schema<string>('string')
  },
  /** A finite number. */
  number(): Schema<number> {
    return new Schema<number>('number')
  },
  /** A boolean. */
  boolean(): Schema<boolean> {
    return new Schema<boolean>('boolean')
  },
  /** Exactly one value, used to spell out an enum. */
  const<T extends string | number | boolean>(value: T): Schema<T> {
    return new Schema<T>('const', { literal: value })
  },
  /** One of several nodes. */
  union(options: readonly Schema[]): Schema {
    return node('union', { options })
  },
}

export default z
