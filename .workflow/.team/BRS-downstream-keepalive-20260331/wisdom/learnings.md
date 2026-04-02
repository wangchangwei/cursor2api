# Learnings - BRS-downstream-keepalive-20260331

## Session Learnings

### SSE Protocol Extension Patterns
- Unknown event types in SSE are ignored by spec-compliant parsers -> safe backward-compatible extension
- `event: error` is non-standard in SSE; use `event: degrade` or `event: status` with structured payload instead
- Unified protocol beats multiple overlapping event types (merge IDEA-3 + IDEA-8 into one schema)

### Adaptive Threshold Design
- Fixed thresholds (e.g., 50 bytes/5s) have high false positive rate on normal slow-start streams
- Two-phase approach: fast-detection phase (aggressive) followed by confirmation phase (wider window) reduces false positives
- Adaptive per-request > global circuit breaker to avoid collective punishment

### Context Injection Safety
- Truncated/partial content as context injection needs minimum-length guard (>= 20 chars alphanumeric)
- Below threshold, fall back to clean probe text to avoid noise injection

### Pre-probing Limitations
- Probe requests cannot predict real request outcome if upstream is failing -> circular dependency
- Any pre-probing adds mandatory latency to all requests even when upstream is healthy
