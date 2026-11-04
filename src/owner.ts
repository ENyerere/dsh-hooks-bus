/**
 * Subscription provenance metadata — self-reported, not an identity system.
 *
 * The bus never guesses a caller package (no stack inspection) and never
 * verifies a declaration. Consumers may attach an owner to improve
 * troubleshooting; the settings page labels it as self-reported. A handler
 * reference that cannot be represented safely inside the consumer package is
 * replaced with {@link EXTERNAL_HANDLER_REF}, so absolute or escaping paths
 * never leak through the API.
 *
 * @module dsh-hooks-bus/owner
 */

/** Consumer-provided, self-reported subscription provenance. */
export interface SubscriptionOwner {
  packageName?: string
  packageVersion?: string
  /**
   * Package-relative handler reference, normalized to POSIX form without a
   * leading `./`. {@link EXTERNAL_HANDLER_REF} marks an absolute, escaping, or
   * otherwise unsafe reference without revealing it.
   */
  handlerRef?: string
}

/** Sentinel for a handler reference that cannot be safely shown. */
export const EXTERNAL_HANDLER_REF = 'external'

const MAX_PACKAGE_NAME = 200
const MAX_PACKAGE_VERSION = 120
const MAX_HANDLER_REF = 500

/**
 * Normalize and sanitize self-reported owner metadata.
 *
 * @param owner - Raw consumer metadata; `undefined` is the old-consumer case.
 * @returns A new object with only safe, non-empty fields, or `undefined` when
 *   nothing usable remains.
 */
export function normalizeOwner(
  owner: SubscriptionOwner | undefined,
): SubscriptionOwner | undefined {
  if (owner === undefined) {
    return undefined
  }
  const packageName = normalizePackageName(owner.packageName)
  const packageVersion = normalizePackageVersion(owner.packageVersion)
  const handlerRef = normalizeHandlerRef(owner.handlerRef)
  if (
    packageName === undefined
    && packageVersion === undefined
    && handlerRef === undefined
  ) {
    return undefined
  }
  return {
    ...(packageName === undefined ? {} : { packageName }),
    ...(packageVersion === undefined ? {} : { packageVersion }),
    ...(handlerRef === undefined ? {} : { handlerRef }),
  }
}

function normalizePackageName(value: string | undefined): string | undefined {
  const text = cleanText(value, MAX_PACKAGE_NAME)
  if (text === undefined || isUnsafeIdentity(text)) {
    return undefined
  }
  return text
}

function normalizePackageVersion(
  value: string | undefined,
): string | undefined {
  const text = cleanText(value, MAX_PACKAGE_VERSION)
  if (text === undefined || text.includes('..')) {
    return undefined
  }
  if (text.includes('/') || text.includes('\\') || text.includes(':')) {
    return undefined
  }
  return text
}

function normalizeHandlerRef(value: string | undefined): string | undefined {
  const text = cleanText(value, MAX_HANDLER_REF)
  if (text === undefined) {
    return undefined
  }
  const unified = text.replaceAll('\\', '/')
  if (
    unified.startsWith('/')
    || /^[a-zA-Z]:/.test(unified)
    || unified.includes(':')
  ) {
    return EXTERNAL_HANDLER_REF
  }
  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return EXTERNAL_HANDLER_REF
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

function isUnsafeIdentity(text: string): boolean {
  if (
    text.startsWith('/')
    || text.startsWith('\\')
    || /^[a-zA-Z]:/.test(text)
    || text.includes('\\')
    || text.includes(':')
  ) {
    return true
  }
  return text.split('/').some((segment) => segment === '..')
}

function cleanText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value.trim()
  if (text.length === 0 || text.length > max) {
    return undefined
  }
  if (hasControlCharacter(text)) {
    return undefined
  }
  return text
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 31 || code === 127) {
      return true
    }
  }
  return false
}
