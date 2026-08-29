# Project intention

## INTENTION

Provide a small Pi extension that renders verified Pi-auth provider quota data in readable, theme-aware `/usage`, `/usage current`, and `/usage expanded` views without changing Pi core. Bare `/usage` is the default programming-quota snapshot.

## INTENTION MATCHED

- Resolve every supported usage report through Pi's signed-in `ctx.modelRegistry` credentials.
- Query no OMP process, external usage CLI, or separate credential store.
- Support only providers whose direct usage endpoint and Pi-auth call are verified: Claude, Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, OpenCode Go, and Grok.
- Keep bare `/usage` focused on main programming quotas; reserve provider detail rows for `current` and `expanded`.
- Show reset countdowns and estimate quota-exhaustion time from elapsed window time and observed quota burn.
- Keep rendering logic testable without a live provider or terminal.

## INTENTION NOT MATCHED

- GitHub Copilot, Z.ai, and other providers without a verified Pi-auth usage call are intentionally not queried.
- The estimate is a pure burn-rate projection from one current snapshot, not a provider billing guarantee; quota resets are shown separately.
