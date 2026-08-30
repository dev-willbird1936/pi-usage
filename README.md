# Pi Usage

A Pi extension by dev-willbird1936 that renders provider usage limits as clean, theme-aware views.

Live usage resolves Pi's signed-in credentials through `ctx.modelRegistry`. The extension has no external usage collector or separate credential store; it reports only providers with direct Pi-auth collectors.

Commands:

```text
/usage                  # compact programming-quota view (default)
/usage current          # expanded view for the active Pi provider
/usage expanded         # expanded view for every verified direct provider
/usage --redact         # compact view with redacted identifiers
/usage --json           # direct Pi-auth usage report as JSON
```

All views share the same themed renderer: status icons, quota bars, account columns, reset timers, and `REMAINING` burn-rate estimates drawn from Pi's active theme colors (`accent`, `success`, `warning`, `error`, `dim`) inside a `borderMuted` frame. `REMAINING` is the projected time to quota exhaustion at the current pace; `resets in` remains the provider's actual reset countdown. `--json` returns the direct Pi-auth reports as JSON. `/usage simple` was removed; bare `/usage` is now the compact view.

## Supported providers

The verified direct collectors support Anthropic (Claude), Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, OpenCode Go, and xAI (Grok). `/usage expanded` shows every reported limit; tab-completion after `/usage --provider` lists these providers. Every request resolves credentials through Pi's `ctx.modelRegistry`, and no OMP process or external credential store is used. Providers without a verified Pi-auth usage endpoint are not queried.

## What bare `/usage` shows

Bare `/usage` is a live programming-quota snapshot. It keeps each provider's main quota or usable balance and hides duplicated detail rows, model/product splits, and spend accounting fields:

- **Claude** — the account 7-day quota plus Extra Usage; 5-hour and model-tier rows are expanded-only.
- **Cursor** — the main `Cursor Models` and `Other Models` meters; aggregate detail is expanded-only.
- **Codex** — the longer primary/secondary programming windows; short windows, Spark/feature meters, and credits are expanded-only.
- **Kimi** — the main weekly quota; short/detail windows and extra balance are expanded-only.
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
