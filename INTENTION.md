# Project intention

## INTENTION

Provide a small Pi extension that renders verified Pi-auth provider quota data in readable, theme-aware `/usage`, `/usage current`, and `/usage expanded` views without changing Pi core. Bare `/usage` is the default programming-quota snapshot, and `/usage chat` emits the same report as plain text for clients that render messages instead of terminal components.

## INTENTION MATCHED

- Resolve direct provider usage through Pi's signed-in `ctx.modelRegistry` or official stored credentials; support the Claude bridge through Claude Code's own OAuth credential when Claude models are hidden from Pi's model scope.
- Query no OMP process or external usage CLI; read only the bridge's existing Claude Code OAuth credential when that provider is requested.
- Support only providers whose direct usage endpoint and Pi-auth call are verified: Claude, Cursor, DeepSeek, Kimi Coding, OpenAI Codex, OpenRouter, OpenCode Go, and Grok.
- Keep bare `/usage` focused on main programming quotas; reserve provider detail rows for `current` and `expanded`.
- Show reset countdowns and estimate quota-exhaustion time from elapsed window time and observed quota burn.
- Render one layout for every surface: the themed TUI view and the plain text stored in the message differ only in color, so non-terminal clients lose nothing.
- Expose the same report as a `usage` tool, because a tool result is the only extension output that reaches hosts which render chat messages instead of terminal components.
- Keep rendering logic testable without a live provider or terminal.

## INTENTION NOT MATCHED

- GitHub Copilot, Z.ai, and other providers without a verified usage call are intentionally not queried.
- Claude Code bridge authentication is a narrow compatibility path, not a general external credential collector.
- The estimate is a pure burn-rate projection from one current snapshot, not a provider billing guarantee; quota resets are shown separately.
- `/usage chat` targets markdown chat clients; it does not detect the host or change the default output.
- Making a slash command display in an ACP host is out of scope: an extension can only emit `custom` or `user` role messages, so a host that drops custom messages must be fixed in the host.
