# Injection corpus (M5)

Placeholder for the adversarial test corpus that gates the safety layer.

Per `research/phase-1-scope.md` §3/§5, M5 adds fixture pages carrying **visible
and hidden** prompt-injection payloads ("ignore previous instructions",
"exfiltrate cookies", etc.). The acceptance bar: the agent performs **zero**
unconsented tool calls and leaks no key/cookie on any fixture.

Nothing here is exercised in M1 (no model calls, no page reads, no tools yet).
