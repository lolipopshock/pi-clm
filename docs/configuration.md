# Configuration

Everything is optional; with no configuration, the budget is the model's context window
and the overflow guard, calibration and reminders are on.

Environment variables set the defaults for every session. The **settings** page of the
panel (`/clm settings`) and `/clm config` change them for the current session; those
changes are saved in the session, so they survive resume, `/reload` and `/tree`, and
`/clm config reset` drops them.

## Settings

`/clm config <setting> <value>` changes one setting; `/clm config <setting>` shows it.
Values keep their case (paths), names do not.

| setting          | what it controls                                                                                                  | `/clm config` values                         | default      |
|------------------|-------------------------------------------------------------------------------------------------------------------|----------------------------------------------|--------------|
| `budget`         | token budget the reminders and the overflow guard measure against                                                 | `200k`, `1.5m`, `200000`, or `window`         | model window |
| `reserve`        | generation headroom kept below the budget; the last reminder fires at budget − reserve                            | `2048`, `2k`                                  | `2048`       |
| `reminders`      | budget fractions at which a `[CLM BUDGET]` note is added to the model's context                                   | `50/75/90%`, `75/90%`, `90%`, `off`           | `50/75/90%`  |
| `guard`          | overflow guard: above budget − reserve, withhold the oldest tool results                                          | `on`, `off`                                   | `on`         |
| `compaction`     | Pi's automatic compaction: `auto` pauses it while the guard enforces the budget, `off` always, `on` leaves Pi alone | `auto`, `off`, `on`                          | `auto`       |
| `cap`            | max characters kept per tool result (head + tail)                                                                 | `10k`, `10000`, `10k:0.5` (head fraction), `off` | off       |
| `steering`       | markdown file with your context-management strategy, appended to the system prompt                                | `house` (the bundled `steering/house-brief.md`), a path, `none` | off |
| `one-tool`       | paper-harness parity: block every tool call after the first in a turn                                             | `on`, `off`                                   | off          |
| `trailer`        | paper-harness parity: append `[context: ~N of B tokens]` to every tool result                                     | `on`, `off`                                   | off          |
| `compact-prompt` | markdown template `/clm-compact` sends instead of the built-in prompt                                             | a path, `default`                             | built in     |

## Environment variables

These are read once, when the extension loads, and use plainer syntax than
`/clm config`: whole numbers, no `k`/`m` suffixes, and paths rather than names.
A value the parser does not accept stops the extension from loading, with a message
saying which variable is wrong.

| variable                    | accepted values                                                                  | sets            |
|-----------------------------|----------------------------------------------------------------------------------|-----------------|
| `PI_CLM_BUDGET`             | a number of tokens, e.g. `200000` (unset = the model window)                     | `budget`        |
| `PI_CLM_RESERVE`            | a number of tokens, e.g. `2048`                                                  | `reserve`       |
| `PI_CLM_REMIND_AT`          | fractions separated by commas, e.g. `0.5,0.75,0.9`; `off` or `none` for no reminders | `reminders` |
| `PI_CLM_OVERFLOW`           | `withhold` or `off`                                                              | `guard`         |
| `PI_CLM_NATIVE_COMPACTION`  | `auto`, `off` or `on`                                                            | `compaction`    |
| `PI_CLM_OBSERVATION_CAP`    | a number of characters, e.g. `10000`, or `10000:0.5` with the head fraction; `off` or `0` | `cap`  |
| `PI_CLM_STEERING`           | a path to a markdown file (for the bundled brief, its path: `<package>/steering/house-brief.md`); `none` or `off` | `steering` |
| `PI_CLM_ONE_TOOL_PER_TURN`  | `1`, `true`, `on` or `yes`; anything else is off                                 | `one-tool`      |
| `PI_CLM_SIZE_TRAILER`       | `1`, `true`, `on` or `yes`; anything else is off                                 | `trailer`       |
| `PI_CLM_COMPACT_PROMPT`     | a path to a markdown template; `default`, `none` or `off` for the built-in prompt | `compact-prompt` |
| `PI_CLM_ESTIMATE_FACTOR`    | a number from 1 to 4: the prior for the size calibration (dense data: `2`)        | —               |
| `PI_CLM_FLOPS_MODEL`        | `auto` (default), `27b`, `9b`, or `off` (no accounting)                          | —               |
| `PI_CLM_FLOPS_PER_TOKEN`    | FLOPs per processed token, e.g. `48.7064e9`; with `PI_CLM_FLOPS_PER_PAIR`, overrides the preset | — |
| `PI_CLM_FLOPS_PER_PAIR`     | FLOPs per attention query–key pair, e.g. `393216`; set together with the above    | —               |
| `PI_CLM_FLOPS_SOURCE`       | `auto` (default: server cached tokens when reported, else prefix match), `server` or `prefix` | — |

## Notes

- **Budget.** The overflow guard acts above `min(budget − reserve, window − 4096 − reserve)`:
  Pi itself clamps the reply length once a request nears the window, so the guard keeps a
  request short of that point even when the budget is larger.
- **Calibration.** Sizes are estimated at four characters per token, then corrected with
  the provider's own count of each request. Dense content (code, random strings) can be
  twice as many tokens as the estimate; for a run that starts with such data,
  `PI_CLM_ESTIMATE_FACTOR=2` avoids one oversized first request.
- **Steering.** The harness text stays protocol-only; a steering document is the one place
  for strategy. `/clm settings` shows the document's name and SHA-256 prefix, so an
  experiment can record which brief was used.
- **Compact prompt.** A template may use `{{mirror}}`, `{{current}}`, `{{budget}}` and
  `{{instructions}}`; unknown placeholders stay as written, and text typed after
  `/clm-compact` is always included.
- **Parity switches** exist to compare with the paper's harness, which allows one tool call
  per turn and shows the context size in every observation. Leave them off for normal use.

## Prefix-reuse FLOPs

Every request's compute is recorded as prefix-reuse FLOPs, the cost measure of
[Context Language Models](https://arxiv.org/abs/2609.37725) (appendix "Prefix-Reuse FLOPs
Computation"; reference implementation in the
[research codebase](https://github.com/facebookresearch/context-language-models/blob/main/clm/clm_harness/flops_metrics/kv_cache_flops.py)).
At request *t* the prompt has *P* tokens and the model generates *G* (the provider's counts);
*R* prompt tokens come from a reused prefix and *U = P − R* are prefilled. The request costs

```text
F = C_token · (U + G) + C_attn · ((P² − R²)/2 + G·P + G²/2)
```

and the run costs the sum. *R* is taken from two sources, and both are recorded for every
request:

- **server cached tokens** — the provider's count of prompt tokens served from its prefix
  cache (`prompt_tokens_details.cached_tokens` on OpenAI-compatible servers, e.g. vLLM with
  `--enable-prompt-tokens-details`; Pi's `cacheRead`).
- **prefix match** — the longest run of leading prompt units (the tool definitions and system
  fields, then each message) that also led an earlier request of the session. This mirrors
  the research code's fallback (prefix matching over the reconstructed context) at message
  granularity, with token weights from the provider's counts: a message's weight is fixed
  where it first appears on a prompt path (the new messages of a request share its *U* in
  proportion to their serialized length), so an append-only turn reuses exactly the previous
  prompt. It does not depend on what the server kept in its cache, and it is always available.

The headline follows the research code's priority: server cached tokens when every request so
far reported them, otherwise the prefix match. Pi's OpenAI-compatible providers report a
missing cache count as 0, so `auto` uses the server count only once some request reported a
positive value. The server's count can be higher than the prefix match (on vLLM the previous reply's
decoded tokens stay cached, which the prefix match counts as prefilled; other sessions on the
same server can share a prefix) or lower (cache block granularity, coarse for hybrid-attention
models; eviction).

**Constants.** `C_token` is two FLOPs per non-embedding parameter; `C_attn` is
4 × full-attention layers × query heads × head dimension. With `PI_CLM_FLOPS_MODEL=auto`
(the default) a Qwen3.5-or-later model id that names a preset size picks it
(`qwen3.6-27b`, `Qwen/Qwen3.8-27B` → `27b`); any other model gets token counts but no FLOPs
until a preset or explicit constants are set.

| preset | `C_token` | `C_attn` | models |
|--------|-----------|----------|--------|
| `27b`  | 2 × 24.3532e9 | 4 × 16 × 6144 | Qwen3.5/3.6-27B and later 27B models of that architecture |
| `9b`   | 2 × 6.9196e9  | 4 × 8 × 4096  | Qwen3.5-9B |

**Where it is recorded.**

- `pi-clm-flops` session entry per request: `promptTokens`, `outputTokens`, `prefixMatch`
  (`reusedTokens`, `newTokens`, `flops`), `serverCached` (`cachedTokens`, `newTokens`,
  `flops`; null without a count), the headline `source` and `flops`, `constants`, and
  `cumulative` totals for the branch so far (both sources; the server totals become null
  once a request had no count). With `--mode json` each entry is also printed as an
  `entry_appended` event.
- `pi-clm-flops-summary` session entry at the end of every agent run: headline `source` and
  `flops`, and the branch totals.
- `/clm status` (one extra line once a request is counted) and the **overview** page.

Responses without a prompt count (failed or aborted requests) are not counted. Totals and
reuse history are rebuilt from the entries on resume and `/tree`. The mirror never contains
any of this.
