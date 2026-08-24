# Pi Usage

A Pi extension by dev-willbird1936 that renders provider usage limits as clean, theme-aware views.

Usage data is collected through the local `omp` CLI on `PATH`, so the extension reuses the credentials already configured on the machine.

Commands:

```text
/usage                  # full styled usage view (all provider limits)
/usage simple           # compact view without noisy buckets (Codex Spark, Grok Build/Tasks)
/usage --redact         # full styled view with redacted identifiers
/usage --history --days 30
/usage --json           # raw JSON passthrough
/usage invalidate
```

Both live views share the same themed renderer: status icons, quota bars, account columns, and reset timers drawn with Pi's active theme colors (`accent`, `success`, `warning`, `error`, `dim`) inside a `borderMuted` frame, so they adapt when you switch themes with `/theme`. `--history`, `--json`, and `invalidate` keep the raw passthrough (ANSI stripped so the output stays theme-neutral).

## Supported providers

Every provider with a usage API is covered: Alibaba Token Plan, Anthropic (Claude, incl. per-model weekly tiers and Extra Usage), Cursor, GitHub Copilot, Google Antigravity, Google Gemini CLI, Kimi, MiniMax, Ollama / Ollama Cloud, OpenAI Codex, OpenCode Go, Synthetic, Umans, xAI (Grok), and Z.ai. `/usage` shows every reported limit; tab-completion after `/usage --provider` lists all of them.

## What `/usage simple` cuts

`/usage simple` is a live snapshot (no `--history`) that keeps only the rows answering "how much of my subscription is left": account-level quota windows and paid overage. It drops rows that only restate those:

- **Codex** — metered-feature buckets (Spark and any future per-feature meters); the shared primary/secondary windows remain.
- **Grok (xAI)** — per-product credit splits (Grok Build, GrokTasks, API); the overall SuperGrok credits row and on-demand balance remain.
- **GitHub Copilot** — per-model billing items; Premium Requests (plus Chat/Completions when limited) remains.
- **Cursor** — the "Personal Usage" aggregate when the itemized monthly meters it duplicates are present.
- **Z.ai** — feature side-quotas (zread/search bundle); token and request quotas remain.
- **Umans** — the instantaneous concurrency gauge; request soft/hard caps remain.
- **OpenCode Go** — the display-only monthly window that never blocks; rolling 5h and weekly remain.

All other providers (Claude, Kimi, MiniMax, Gemini, Antigravity, Alibaba, Synthetic, Ollama) report only primary quotas, so nothing is cut.

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

The `omp` executable must be available on `PATH`. The extension gives the subprocess 120 seconds because the first provider refresh can be slow.
