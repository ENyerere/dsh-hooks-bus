/** Fixture handler module for the declarative path-resolution test. */
export default function declarativeHandler(): {
  action: 'ask'
  reason?: string
} {
  return { action: 'ask' }
}
