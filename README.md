# Pi Usage

By [dev-willbird1936](https://github.com/dev-willbird1936).

A Pi extension that renders provider usage limits as clean, theme-aware views.

Live usage resolves direct-provider credentials through `ctx.modelRegistry` and Pi's official stored-credential API. Claude subscription quotas use the Claude Code CLI login; Pi `/login anthropic` is a different OAuth client and is only used if that login is missing or rejected. The extension has no external usage collector or OMP dependency; it reports only verified provider usage.

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
 ✓ OpenRouter credits        ·······················   $12.40 left

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
   $400 / $400 · 100% used · $0 left · 1 quota
```

## Supported providers

The verified direct collectors support Anthropic (Claude), Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, OpenCode Go, and xAI (Grok). Claude usage is the Claude Code / Claude Bridge subscription (Max/Pro), not Pi's console Anthropic OAuth. `claude-bridge` is accepted as an alias so hiding Claude models in `/models` does not hide Claude usage from `/usage`. `/usage expanded` and `/usage extended` show every reported limit; tab-completion after `/usage --provider` lists these providers. Direct providers resolve credentials from Pi's model registry or Pi's official stored-credential API. Providers without a verified usage endpoint or credential are not shown.

## What bare `/usage` shows

Bare `/usage` is a live programming-quota snapshot. It keeps each provider's main quota or usable balance and hides duplicated detail rows, model/product splits, and spend accounting fields:

- **Claude** — the account 7-day quota plus Extra Usage; 5-hour and model-tier rows are expanded-only.
- **Cursor** — the main `Cursor Models` and `Other Models` meters; aggregate detail is expanded-only.
- **Codex** — the longer primary/secondary programming windows plus available Codex credits; short windows and Spark/feature meters are expanded-only.
- **Kimi** — the main weekly quota plus available extra balance; expired or exhausted coding plans are omitted; short/detail windows and balance accounting components are expanded-only.
- **OpenRouter** — remaining account credits, like DeepSeek; the key spending cap and daily/weekly/monthly usage analytics are expanded-only.
- **DeepSeek** — total balance; granted and topped-up components are expanded-only.
- **OpenCode Go** — the weekly quota; rolling and monthly rows are expanded-only.
- **Grok (xAI)** — overall credits, monthly included usage, and on-demand balance; per-product splits are expanded-only.

GitHub Copilot and Z.ai are intentionally not listed until Pi's signed-in credential and a stable usage endpoint can be verified for them.

## Credentials

This extension does not ship API keys. Live usage reads credentials from Pi's model registry and Pi's stored-credential API.

Claude Max/Pro quotas use the Claude Code CLI login file:

- `$CLAUDE_CONFIG_DIR/.credentials.json` when `CLAUDE_CONFIG_DIR` is set
- `~/.claude/.credentials.json` otherwise

A successful OAuth refresh writes the new access token (and rotated refresh token, if any) back to that same file. Do not copy that file into this repository.

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
