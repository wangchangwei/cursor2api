# Decisions - BRS-downstream-keepalive-20260331

## Key Architecture Decisions

### Decision 1: Abandon IDEA-1 (Pre-stream Probe)
**Reason**: Circular dependency -- probe assumes upstream can return content, which is exactly the problem we are solving. Additional 2-3s mandatory delay on every request with no predictive value.
**Alternatives considered**: Side-channel health endpoint (outside our control)
**Resolution**: Do not proceed with pre-probing as predictive mechanism

### Decision 2: Merge IDEA-3 + IDEA-7 + IDEA-8 into Unified SSE Metadata Protocol
**Reason**: All three propose SSE metadata mechanisms with overlapping scope. IDEA-3 (meta frames), IDEA-7 (semantic degradation naming), IDEA-8 (completeness receipt) complement each other.
**Schema**: Three event types sharing the same field schema: `event: degrade`, `event: status`, `event: receipt`
**Resolution**: Single unified SSE stream metadata protocol

### Decision 3: Replace IDEA-6 (Fake Content) with SSE Comment Progress Signals
**Reason**: Artificial "Processing your request..." text deceives downstream and may corrupt real thinking output parsing. SSE comments (`: ...\n\n`) provide progress signals without claiming to be content.
**Resolution**: Remove fake content injection entirely

### Decision 4: Replace Global Circuit Breaker with Per-Request Adaptive Hints
**Reason**: 60s global window with all-requests-degraded causes collective punishment on intermittent failures. Cursor API断流 is highly sporadic, not persistent.
**Resolution**: Per-request adaptive degradation signals without global state contamination

### Decision 5: Two-Phase Adaptive Velocity Threshold
**Reason**: Fixed 50 bytes/5s threshold has high false positive rate on normal slow-start streams.
**Resolution**: Fast-detection phase (50 bytes/10s) followed by confirmation phase (200 bytes/20s) before retry

### Decision 6: Conditional Context Injection with Minimum-Length Guard
**Reason**: Truncated partial content (half-sentences, garbled) as context introduces noise.
**Resolution**: Only inject partial content as context if >= 20 alphanumeric chars; otherwise use default probe text
