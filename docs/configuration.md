# Configuration

Everything is optional; with no configuration, the budget is the model's context window
and the overflow guard, calibration and reminders are on.

A settings file and environment variables set the defaults for every session. The
**settings** page of the panel (`/clm settings`) and `/clm config` change them for the
current session; those changes are saved in the session, so they survive resume, `/reload`
and `/tree`, and `/clm config reset` drops them.

From lowest to highest: built-in default, settings file, environment variable, session
change.

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

## Settings file

`~/.pi/agent/pi-clm/settings.json` (under `PI_CODING_AGENT_DIR` when that is set) holds
defaults for every session. It is optional and edited by hand; pi-clm never writes it.
Its names and values are those of `/clm config` in the table above:

```json
{
  "budget": "200k",
  "reminders": "75/90%",
  "cap": "10k:0.5",
  "steering": "house"
}
```

- A value is a string as typed after `/clm config <setting>`; a plain number or `true` /
  `false` also works where it reads the same (`200000`, `true`).
- In `steering` and `compact-prompt`, `~` is the home directory and a relative path starts
  at the settings file's directory.
- The file is read once, when the extension loads: an edit applies on the next `/reload`.
  A setting changed in a session keeps its session value until `/clm config reset`.
- A mistake in the file never stops Pi from starting. An unknown setting or a value the
  setting does not accept is skipped and the rest applies; a file that is not valid JSON is
  ignored as a whole. Either way a warning naming the file and the setting is shown when
  the session starts and in `/clm status` until the file is fixed.

## Environment variables

An environment variable that is set overrides the settings file's value for the same
setting. These are read once, when the extension loads, and use plainer syntax than
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
