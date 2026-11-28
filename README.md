# pi-clm

```
  ____ _     __  __
 / ___| |   |  \/  |     
| |   | |   | |\/| |
| |___| |___| |  | |     
 \____|_____|_|  |_|     pi-clm — the agent that manages its own context
```

`pi-clm` is a [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension 
that lets the agent manage its own context: the language model can generate functions to 
modify the context (mapped as a file), and the edited version becomes its next input. 
Check our paper [Context Language Models](https://arxiv.org/pdf/2609.37725) and [research
codebase](https://github.com/facebookresearch/context-language-models). 

## Install

```sh
pi install npm:@lolipopshock/pi-clm

# From source, or to try it for one session without installing:
pi install git:github.com/lolipopshock/pi-clm
pi -e git:github.com/lolipopshock/pi-clm
```

## Quick start

| command | what it does |
|---------|--------------|
| `/clm` | open the panel: **overview** (context size over time + compaction points) <br><img src=".github/images/overview.png" alt="The overview page: context size per request, with two points where the model compacted its own context" width="720"> <br> **input** (what the next request contains) · **edits** (per-revision side-by-side diff) <br><img src=".github/images/edits.png" alt="The edits page: a tool result before and after the model shortened it" width="720">|
| `/clm status` | three lines: next request vs budget, edits, changed settings (plus prefix-reuse FLOPs once a request is counted; including Pi's own compaction summaries, see [configuration](docs/configuration.md#prefix-reuse-flops)) |
| `/clm config` | open **settings**; `/clm config <setting> <value>` changes one, `/clm config reset` drops this session's changes<br><img src=".github/images/settings.png" alt="The settings page: sizes, guard, files, and every setting" width="720"> |
| `/clm-compact [instructions]` | ask the model to compact its own context now; anything you add (e.g. what to keep) is passed along. The result shows on the **edits** page |
| `/clm on` / `off` / `reset` | enable, use raw context, discard the projection |

In the panel: `1–4` or `Tab` switch pages, `← →` step through compaction points, `z`
zooms the chart, `Enter` opens the selection, `q` closes.

## Docs

- [How it works](docs/how-it-works.md) — the mirror, what runs without the model, the panel, safety.
- [Configuration](docs/configuration.md) — budget, reserve, reminders, guard, steering and the other settings.
- [Architecture](docs/architecture.md) — the system as implemented, design notes, known limitations.
- [Development](docs/development.md) — setup, checks, releasing.

## Citation

If you use pi-clm in your research, please cite
[Context Language Models](https://arxiv.org/abs/2609.37725):

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```
