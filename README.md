# Pi Usage

A Pi extension by dev-willbird1936 that renders provider usage limits as clean, theme-aware views.

Live usage resolves direct-provider credentials through `ctx.modelRegistry` and Pi's official stored-credential API. When Claude models are supplied by `claude-bridge`, it reads Claude Code's existing OAuth credential as a narrow fallback. The extension has no external usage collector or OMP dependency; it reports only verified provider usage.

Commands:

```text
/usage                  # compact programming-quota view (default)
/usage current          # expanded view for the active Pi provider
/usage expanded         # expanded view for every verified direct provider
/usage extended         # alias for expanded
/usage chat             # plain fenced text for non-terminal chat clients
/usage --redact         # compact view with redacted identifiers
/usage --json           # direct usage report as JSON
```

Every quota renders as one row — status icon, label, usage bar, and what is still left — with a dim line underneath carrying the account, the used/limit detail, the reset countdown, and the burn-rate forecast. Label, bar, and value columns align across all providers. `runs out in ~…` is the projected time to quota exhaustion at the current pace; `resets in` remains the provider's actual reset countdown.

`/usage current`, `/usage expanded`, and `/usage extended` use the same renderer with filtering disabled; `current` limits the request to the active provider. `--json` returns the verified usage reports as JSON. `/usage simple` was removed; bare `/usage` is now the compact view.

### Chat clients (AionUi, ACP, RPC)

The extension also registers a `usage` **tool**, and that is the path to use outside Pi's terminal. Slash commands render as a Pi *custom message*, which only the TUI draws; a tool result travels the normal agent-chat path, so any host displays it. Just ask in plain language:

```text
how much quota do i have left?
is my claude weekly limit nearly up?
```

The tool takes an optional `view` (`compact`, the default, or `expanded`) and an optional `provider`. It returns the same plain render shown below.

`/usage chat` (or `--chat` on any view, e.g. `/usage expanded --chat`) wraps that render in a fenced `text` block so markdown clients keep the monospace alignment instead of collapsing the columns. Note that slash commands reach the client only if the host forwards Pi custom messages — the `pi-acp` bridge currently drops them and never ends the turn, so in AionUi use the tool rather than the command.

```text
Usage · compact                                               updated 1m ago
─────────────────────────────────────────────────────────────────────────

OpenRouter
 ✓ OpenRouter key limit      ░░░░░░░░░░░░░░░░░░░░░░░░  $59.97 left
   $0.03 / $60 · 0.06% used

Claude · you@example.com
 ✓ Claude 7 Day              ██████████▓░░░░░░░░░░░░░     55% free
   45% used · resets in 1d 15h · runs out in ~6d 12h

Cursor
 ✓ Cursor Models (Monthly)   ███▓░░░░░░░░░░░░░░░░░░░░   83.8% free
   16.2% used · resets in 16d 7h · runs out in ~75d 19h
 ✗ Other Models (Monthly)    ████████████████████████      $0 left
   $400 / $400 · 100% used · resets in 16d 7h

─────────────────────────────────────────────────────────────────────────
Total usage
   20.8% used · 79.2% left · 4 quotas
   $400.03 / $460 · 87% used · $59.97 left · 2 quotas
```

## Supported providers

The verified direct collectors support Anthropic (Claude), Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, OpenCode Go, and xAI (Grok). Claude's `claude-bridge` provider is also accepted as an alias, so hiding Claude models in `/models` does not hide Claude usage from `/usage`; when no Pi Anthropic OAuth credential is available, the bridge uses Claude Code's own OAuth credential. `/usage expanded` and `/usage extended` show every reported limit; tab-completion after `/usage --provider` lists these providers. Direct providers resolve credentials from Pi's model registry or Pi's official stored-credential API. Providers without a verified usage endpoint or credential are not shown.

## What bare `/usage` shows

Bare `/usage` is a live programming-quota snapshot. It keeps each provider's main quota or usable balance and hides duplicated detail rows, model/product splits, and spend accounting fields:

- **Claude** — the account 7-day quota plus Extra Usage; 5-hour and model-tier rows are expanded-only.
- **Cursor** — the main `Cursor Models` and `Other Models` meters; aggregate detail is expanded-only.
- **Codex** — the longer primary/secondary programming windows plus available Codex credits; short windows and Spark/feature meters are expanded-only.
- **Kimi** — the main weekly quota plus available extra balance; short/detail windows and balance accounting components are expanded-only.
- **OpenRouter** — the key spending limit; daily/weekly/monthly usage analytics are expanded-only.
- **DeepSeek** — total balance; granted and topped-up components are expanded-only.
- **OpenCode Go** — the weekly quota; rolling and monthly rows are expanded-only.
- **Grok (xAI)** — overall credits, monthly included usage, and on-demand balance; per-product splits are expanded-only.

GitHub Copilot and Z.ai are intentionally not listed until Pi's signed-in credential and a stable usage endpoint can be verified for them.

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
