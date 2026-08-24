# Changelog

## [0.1.0] - 2026-08-24

Initial release.

- `/usage` renders a full themed usage view (status icons, quota bars, account columns, reset timers) for all 16 supported providers: Alibaba Token Plan, Anthropic (Claude), Cursor, GitHub Copilot, Google Antigravity, Google Gemini CLI, Kimi, MiniMax, Ollama / Ollama Cloud, OpenAI Codex, OpenCode Go, Synthetic, Umans, xAI (Grok), and Z.ai.
- `/usage simple` compact view that keeps only subscription-level quota rows and cuts per-model/per-product breakdowns, feature side-quotas, instantaneous gauges, and display-only windows.
- Full Pi theme support: all colors come from the active theme and re-render on `/theme` switch; raw passthrough output (`--history`, `--json`, `invalidate`) is ANSI-stripped to stay theme-neutral.
- `--provider` tab-completion for all supported providers, plus `--redact`, `--history`, `--json`, and `invalidate` forwarding.
