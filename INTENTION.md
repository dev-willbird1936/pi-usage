# Project intention

## INTENTION

Provide a small Pi extension that renders provider quota data in readable, theme-aware `/usage` and `/usage simple` views without changing Pi core.

## INTENTION MATCHED

- Resolve Claude and Grok subscription usage with Pi-managed OAuth credentials.
- Preserve OMP-backed coverage for providers without a direct Pi usage collector.
- Show reset countdowns and estimate quota-exhaustion time from elapsed window time and observed quota burn.
- Keep rendering logic testable without a live provider or terminal.

## INTENTION NOT MATCHED

- Direct Pi-auth usage collectors do not yet cover every provider supported by the OMP fallback.
- The estimate is a pure burn-rate projection from one current snapshot, not a provider billing guarantee; quota resets are shown separately.
