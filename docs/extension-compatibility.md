# Extension context compatibility

## Scope

CLM contributes its protocol and steering through the native
`live_context_management` prompt section when Pi exposes mutable sections. Older hosts
retain the existing string-return fallback. Restored context views exclude Pi-owned
system messages so checkpoint validation uses the same conversation space as the
`context` hook.

A whole `systemPrompt` return is an intentional replacement on modern Pi, not an
additive contribution. CLM does not clear another extension's override, rewrite its
handlers, or relax checkpoint digests to mask a mismatch.

## Companion extensions

- `@henryqw/pi-add-dir@3.1.1` already uses the native `pi_add_dir` section. It accepts
  the older `add-dir:state` directory entries. No source patch is required for the
  prompt-composition issue. Its commands are `/dir-add`, `/dir-ls` and `/dir-reload`;
  `add_directory` is model-only, while file search has structured codemode results.
- The open-codebase-index fix belongs in that project's
  `src/adapters/shared/extension-core.ts`: contribute workflow guidance through
  `codebase_index_guidance` and retain its older-host fallback. Build its checkout
  before testing or loading `dist/pi-extension.js`.
- The older unscoped `pi-add-dir@1.3.1` and index `0.36.3` release can still freeze
  later instructions. Updating only CLM is not a complete rollout. Do not load an npm
  release and its local checkout together.

Companion patch artifacts are intentionally not maintained in this repository; each
project should carry its own source change and tests.

## Validation and remaining limits

The CLM regressions are tested against pinned Pi 0.85.0; real request construction was
also checked on Pi 1.0.3 and 1.1.0. With the Henry fork and rebuilt index checkout, all
24 load orders / 72 HTTP requests retained the five expected instruction markers.
A separate real RPC fixture covered model-issued mirror compression, `/clm-compact`,
native compaction, clone isolation, fork inheritance, tree restoration and parent-session
restoration. Native summarizers intentionally use their own instructions rather than
the ordinary agent prompt. These controls test lifecycle/request integrity, not model
summary quality or arbitrary third-party behavior.

- A varying `context` transform before CLM can still invalidate its exact-prefix
  checkpoint, even when only an injected timestamp changes. Prefer CLM before those
  transforms; do not ignore unmatched source prefixes.
- Continuity ordering (issue #1) is a separate change: managed continuity leads the
  conversation in CLM mode. It does not guarantee every provider cache continuation.
- Prompt-only usage accounting is a separate budgeting correction.
- Resets after a reload or resume (issue #9) are handled by the resume recovery described
  in [architecture.md](architecture.md) §6; the snapshot fix here does not address them.
- The index checkout's full suite was not entirely green: watcher assertions also failed
  on untouched HEAD, and a setup timeout passed in isolation. Successful adapter/wire
  checks are not a waiver of the companion project's full validation gate.
