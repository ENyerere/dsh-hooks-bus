# Changelog

## 0.3.0

Release for the P7 v3 upgrade, validated against DeepSeek Harness `0.2.1-rc.5`.
The working-stage label "v3" is **not** the package major version.

### Added

- Self-reported subscription provenance: optional `owner.packageName`,
  `owner.packageVersion`, and normalized package-relative `owner.handlerRef`,
  exposed through `state().subscriptions[].owner`.
- Optional `key`, `before`, and `after` on declarative subscription entries.
  Ordering is scoped to one `declare()` batch and one event only, with stable
  topological sorting; runtime `on()` behavior is unchanged.
- Persistence state exposed as `state().persistence` with the four states
  `unavailable`, `initializing`, `ready`, and `error`.
- M2 real-consumer probe for `dsh-hook-guard-demo` and M3 cycle coverage.

### Fixed

- Persistence no longer silently stays in memory when `storageDomain` is
  activated after the bus: initialization waits through `ctx.inject`, merges
  pre-open logs without duplication, closes stale domains, and preserves pause
  toggles made before the domain opens.
- A storage service removal now settles to `memory/unavailable` when no
  replacement service appears.
- Cycle detection now includes keyless declarative nodes instead of filtering
  edges by key presence.
- `cordis` and `schemastery` are runtime dependencies, so a clean profile
  installation works even when the profile does not auto-install peers.

### Compatibility

- Existing `on()` / `declare()` call sites remain valid; all new fields are
  optional. The storage domain stays `dsh_hooks_bus` v1 with its existing
  record schema.
- No claim is made for all DSH versions; the verified baseline is
  DeepSeek Harness `0.2.1-rc.5`.
