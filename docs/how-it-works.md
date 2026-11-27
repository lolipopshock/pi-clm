# How pi-clm works

pi-clm lets the model manage its own context. The context the model will see on its next
request is mirrored to a file; the model edits that file with ordinary tools; the edited
version becomes its next context. Pi's session history is never rewritten.

## The mirror

Before every request pi-clm writes the model-visible conversation to a private file:

```text
[[LIVE_CONTEXT version=1 revision=2 document=<nonce> baseline=<digest>]]

[[CTX_TURN document=<nonce> index=1 role=user id=1-b1ba26e534cb protected=false]]
Count lines of two commands.

[[CTX_TURN document=<nonce> index=2 role=notes id=new-tracker protected=false]]
TASK TRACKER
- ...
```

During its turn the model may rewrite that file however it likes: shorten stale tool
output in place, delete or reorder blocks, insert new ones (`id=new-…`, any role label),
grow a scratchpad, or replace everything with plain text (that becomes one `notes` block
after the original task). At the end of the turn pi-clm validates the file, keeps
untouched messages as their original objects, repairs tool-call pairs, saves the result as
a revision on the current branch, and uses it for the next request. Nothing shrinks
unless the model shrinks it; the harness only guarantees the request is legal and tells
the model how much room it has.

## What runs without the model

Two things run on their own, because a single turn with many parallel tool calls can
outrun any reminder:

- **Overflow guard** — if the estimated request exceeds the budget (default: the model's
  context window minus generation headroom), the oldest tool results after the last edit
  are swapped for one-line notes pointing at files with the full text.
- **Calibration** — the size estimate is corrected against the provider's own count of
  each request, so dense content (code, random strings) does not slip past the budget.

Pi's automatic compaction is paused in CLM mode; it measures the raw transcript and would
discard the model's edits. Manual `/compact` still works, but it summarizes the raw
history and resets the projection; `/clm-compact` instead asks the model to do the
compaction by editing its mirror, with a fixed prompt you can replace.

## Compute accounting

pi-clm also counts the compute of every request as **prefix-reuse FLOPs**, the cost
measure of [Context Language Models](https://arxiv.org/abs/2609.37725): a server with
prefix caching reuses the longest leading part of the prompt it has already seen and
prefills only the rest, so an edit in the middle of the context costs a re-prefill of
everything after it. The reused part comes from the server's cache-hit count when it reports
one, and from pi-clm's own prefix match otherwise; both are recorded. Each request is recorded in the session (`pi-clm-flops` entries, also
printed by `--mode json`), each run ends with a `pi-clm-flops-summary` entry, and
`/clm status` and the overview show the running total. This is bookkeeping only; nothing
is sent to the model. See [configuration.md](configuration.md#prefix-reuse-flops).

## The panel

`/clm` opens the panel; `/clm overview|input|edits|settings` opens a page directly
(outside the TUI it prints the page). `1–4` or `Tab` switch pages, `q` closes.

- **overview** — context size per request, the budget as a dashed line, the points
  where an edit was accepted, and the prefix-reuse FLOPs so far. It opens on the latest request; `← →` step through
  compaction points (the chart pans to keep the selection centred) and back to now; `z`
  cycles the x axis between **all** (the whole history fitted into the width, the default;
  peak per bucket), **detail** (one column per request, panning) and **turns** (one column
  per user turn); `Enter` opens a compaction point in **edits** (or, at now, the current
  input).
- **input** — how much of the raw transcript the model currently sees, and the effective
  message list.
- **edits** — per revision, every message before and after. `Enter` expands a message into
  a side-by-side diff (changed words highlighted; one column below 60 columns), `a`
  expands all, `↑ ↓` scroll through a long diff, `← →` switch revisions.
- **settings** — sizes, the guard limit and files above the settings list; `↑ ↓` select and
  `Enter` changes a setting (cycles its choices, or asks for a value). Changes apply at
  once and are saved in the session; see [configuration.md](configuration.md).

## Safety

The mirror holds conversation data (`0700`/`0600`, under the OS temp dir, removed at
shutdown). Model-editable memory is a prompt-injection surface: injected text can induce
the model to rewrite its own constraints. pi-clm keeps the real system prompt out of the
mirror and lowers authored roles to plain text, but it cannot stop a model from dropping
context it should have kept. Remote tool backends cannot see the local mirror.

## Further reading

[architecture.md](architecture.md) describes the system as implemented: the request
lifecycle, the mirror format, validation, persistence and branches, the budget, the
overflow guard, settings, the panel, and the design notes and known limitations.
