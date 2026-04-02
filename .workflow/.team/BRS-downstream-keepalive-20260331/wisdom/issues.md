# Issues - BRS-downstream-keepalive-20260331

## Risks and Known Issues

### Risk 1: Downstream SSE Event Parsing Unverified (Severity: MEDIUM)
- No evidence that Claude Code (downstream) parses custom SSE event types
- If downstream ignores all custom events, Proposal 1 provides zero value
- Mitigation: Design is backward-compatible; even if ignored, behavior is unchanged
- Next action: Test with actual Claude Code SSE client behavior

### Risk 2: Adaptive Threshold Tuning Requires Production Data (Severity: HIGH)
- All velocity thresholds (fast-detection, confirmation) are still heuristic
- Without real production byte velocity distributions, false positive/negative rates are unknown
- Mitigation: Implement SSE status events to collect telemetry before full deployment
- Next action: Instrument with status events first, collect 1 week of data, then tune

### Risk 3: Half-Open Probe Reintroduces IDEA-1 Problems (Severity: MEDIUM)
- Proposal 2's optional half-open probing could add latency on degraded requests
- If probe itself fails (like IDEA-1), we waste another request cycle
- Mitigation: Make half-open probe optional/configurable; disable if it causes more harm than good
- Next action: A/B test with probe disabled first, enable only if data supports it

### Risk 4: Proposal 2 Scope Creep (Severity: MEDIUM)
- Adaptive per-request degradation touches cursor-client.ts, handler.ts, and openai-handler.ts
- Multiple concurrent changes increase integration risk
- Mitigation: Implement Proposal 1 (SSE protocol) first as isolated change, validate before Proposal 2
- Next action: Gate Proposal 2 behind Proposal 1 completion

### Risk 5: Root Cause Not Addressed (Severity: LOW)
- Neither proposal fixes the upstream stream breaks themselves
- System can only detect, signal, and mitigate; upstream stability is outside our control
- Mitigation: Explicit in design; this is a damage control layer, not a fix
- Next action: Document this limitation clearly for stakeholders
