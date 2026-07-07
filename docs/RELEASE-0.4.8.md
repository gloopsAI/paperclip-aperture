# paperclip-aperture 0.4.8

`0.4.8` is a Paperclip `2026.707.0` compatibility and hygiene release.

## Highlights

- upgraded `@paperclipai/plugin-sdk` from `2026.609.0` to `2026.707.0`
- keeps the minimum Paperclip host version at `2026.525.0` because the new
  Focus behavior degrades safely when older hosts omit newer fields
- preserves Paperclip issue watchdog summaries in Focus metadata
- treats pending watchdog triggers as first-class Focus evidence without
  promoting every active watchdog into `Now`
- adds regression coverage for watchdog-triggered and active-but-completed
  watchdog states
- refreshes vulnerable dev-tooling dependencies and pins patched nested
  versions for Vite, esbuild, PostCSS, and picomatch

## Why This Matters

- lets Focus react to Paperclip watchdogs when they signal fresh unresolved
  review activity
- keeps normal active watchdog configuration calm, so planning-mode work does
  not become interruptive merely because a watchdog exists
- aligns the plugin with the current Paperclip SDK while preserving the
  existing install compatibility boundary
- clears the current package audit without changing the runtime dependency on
  `@tomismeta/aperture-core@0.7.0`

## Validation

- `pnpm audit --json`
- `pnpm typecheck`
- `pnpm test -- tests/plugin.spec.ts`
