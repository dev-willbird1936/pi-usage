# Changelog

## [0.2.0] - 2026-08-29

- Claude and Grok live usage now resolve OAuth credentials from Pi instead of requiring a matching OMP login. OMP remains a fallback for providers without a direct Pi usage collector.
- Live quota rows now show `REMAINING: ~…`, forecasting quota exhaustion from elapsed window time and observed usage; the reset countdown remains a separate value.
- `/usage` and `/usage simple` now keep logged-in accounts whose usage API returned nothing (`accountsWithoutUsage` in `omp usage --json`) instead of dropping the provider. Claude and Grok show as `no usage data` rather than disappearing.
- The simple view now hides short quota windows (including 5-hour limits) and Claude's Fable bucket, then adds a bottom `Total usage` summary for visible percentages and compatible quantities.
- `--json` now emits a merged report so Pi-auth usage can appear alongside OMP reports.

## [0.1.0] - 2026-08-24

Initial release.

- `/usage` renders a full themed usage view (status icons, quota bars, account columns, reset timers) for all 16 supported providers: Alibaba Token Plan, Anthropic (Claude), Cursor, GitHub Copilot, Google Antigravity, Google Gemini CLI, Kimi, MiniMax, Ollama / Ollama Cloud, OpenAI Codex, OpenCode Go, Synthetic, Umans, xAI (Grok), and Z.ai.
- `/usage simple` compact view that keeps only subscription-level quota rows and cuts per-model/per-product breakdowns, feature side-quotas, instantaneous gauges, and display-only windows.
- Full Pi theme support: all colors come from the active theme and re-render on `/theme` switch; raw passthrough output (`--history`, `--json`, `invalidate`) is ANSI-stripped to stay theme-neutral.
- `--provider` tab-completion for all supported providers, plus `--redact`, `--history`, `--json`, and `invalidate` forwarding.
