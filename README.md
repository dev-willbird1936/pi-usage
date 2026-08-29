# Pi Usage

A Pi extension by dev-willbird1936 that renders provider usage limits as clean, theme-aware views.

Live Claude and Grok usage uses Pi's resolved OAuth credentials from `ctx.modelRegistry`. The local `omp` CLI remains a fallback for providers without a direct Pi usage collector, so those providers still use their OMP credential store.

Commands:

```text
/usage                  # full styled usage view (all provider limits)
/usage simple           # compact view without noisy buckets and short windows
/usage --redact         # full styled view with redacted identifiers
/usage --history --days 30
/usage --json           # merged JSON usage report
/usage invalidate
```

Both live views share the same themed renderer: status icons, quota bars, account columns, reset timers, and `REMAINING` burn-rate estimates drawn with Pi's active theme colors (`accent`, `success`, `warning`, `error`, `dim`) inside a `borderMuted` frame, so they adapt when you switch themes with `/theme`. `REMAINING` is the projected time to quota exhaustion at the current pace; `resets in` remains the provider's actual reset countdown. The simple view ends with `Total usage`, aggregating visible percentage quotas and compatible quantities with used and remaining values. `--history` and `invalidate` keep the raw passthrough (ANSI stripped so the output stays theme-neutral). `--json` returns a merged JSON report so Pi-auth usage can be included alongside OMP reports.

## Supported providers

The extension currently supports these provider IDs: Alibaba Token Plan, Anthropic (Claude, incl. per-model weekly tiers and Extra Usage), Cursor, GitHub Copilot, Google Antigravity, Google Gemini CLI, Kimi, MiniMax, Ollama / Ollama Cloud, OpenAI Codex, OpenCode Go, Synthetic, Umans, xAI (Grok), and Z.ai. `/usage` shows every reported limit; tab-completion after `/usage --provider` lists all of them. Claude and Grok reports use Pi OAuth auth. OMP-reported logged-in accounts whose usage API returned no limits still render as `no usage data` instead of being omitted.

## What `/usage simple` cuts

`/usage simple` is a live snapshot (no `--history`) that keeps only the rows answering "how much of my subscription is left": account-level quota windows and paid overage. Short windows (24 hours or less, such as 5-hour limits) and Claude's Fable model bucket are hidden. It drops rows that only restate those:

- **Codex** — metered-feature buckets (Spark and any future per-feature meters); the shared primary/secondary windows remain.
- **Grok (xAI)** — per-product credit splits (Grok Build, GrokTasks, API); the overall SuperGrok credits row and on-demand balance remain.
- **GitHub Copilot** — per-model billing items; Premium Requests (plus Chat/Completions when limited) remains.
- **Cursor** — the "Personal Usage" aggregate when the itemized monthly meters it duplicates are present.
- **Z.ai** — feature side-quotas (zread/search bundle); token and request quotas remain.
- **Umans** — the instantaneous concurrency gauge; request soft/hard caps remain.
- **OpenCode Go** — the display-only monthly window that never blocks; weekly remains.

All other provider rows remain unless they are short windows or the Claude Fable model bucket.

## Install

From npm:

```bash
pi install npm:pi-usage-limits
```

From GitHub:

```bash
pi install git:github.com/dev-willbird1936/pi-usage
```

Restart Pi or run `/reload`, then use `/usage`.

The `omp` executable is required only for fallback providers. The extension gives that subprocess 120 seconds because the first provider refresh can be slow; Claude and Grok continue to work from Pi auth when `omp` is unavailable.
