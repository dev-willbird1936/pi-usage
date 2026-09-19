# Changelog

## [0.5.3] - 2026-09-19

- Persist a refreshed Claude Code login by replacing `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`) even when that file already exists, as on Windows.

## [0.5.2] - 2026-09-09

- Compact `/usage` now reads the Claude Code CLI login for Claude Max / Pro quotas. Pi `/login anthropic` is a different OAuth client and is only tried if the Claude Code token is missing or rejected.

## [0.5.1] - 2026-09-08

- OpenRouter compact view now shows remaining account credits instead of the unused key spending cap.
- Cursor usage prefers a Cursor session JWT over a CLIProxy API key, so `/usage` no longer reports HTTP 401 from `api2.cursor.sh`.
- Kimi is omitted when the coding plan returns HTTP 429/402 (insufficient balance).

## [0.5.0] - 2026-08-31

- Redesigned the usage layout: one row per quota with globally aligned label, bar, and remaining-value columns, a dim detail line underneath, and a rule-separated header and totals block.
- The account identity now sits in the provider heading instead of a placeholder `account N` row; it only repeats per row when a provider really has several accounts.
- Plain and themed output now share one renderer, so chat clients and LLM context see the same bars and alignment the TUI does.
- Added a `usage` tool so the report reaches non-terminal hosts (AionUi, ACP, RPC) through the normal agent-chat path; slash commands emit a Pi custom message, which only the TUI renders. Takes optional `view` (`compact`/`expanded`) and `provider`.
- Added `/usage chat` (and the `--chat` flag) to emit the report as a fenced plain-text chat message for clients that do render custom-message content.
- Renamed the view titles to `Usage · compact`, `Usage · current`, and `Usage · expanded`, and the burn-rate forecast from `REMAINING: ~…` to `runs out in ~…`.

## [0.4.0] - 2026-08-29

- Bare `/usage` is now the default compact programming-quota view; `/usage current` expands the active provider and `/usage expanded` expands every verified direct provider.
- Removed the `/usage simple` command name.
- Added verified Pi-auth collectors for Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, and OpenCode Go.
- All live requests now use credentials resolved from Pi; unsupported providers are not queried.
- Restored the former compact view's `Usage (simple)` title, short-window filtering, and Cursor/Kimi row labels.

## [0.3.0] - 2026-08-29

- Removed the OMP subprocess fallback and its separate credential-store dependency.
- `/usage` now reports only direct Pi-auth collectors for Claude and Grok.
- Removed the OMP-backed `--history` and `invalidate` passthrough commands.
- JSON output now contains direct Pi-auth reports only.

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
