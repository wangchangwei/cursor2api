# Synthesis Report - Round 1

## Metadata

| Field | Value |
|-------|-------|
| Session | BRS-downstream-keepalive-20260331 |
| Topic | 修复下游断开问题（响应过短/空内容导致下游断流） |
| Role | Synthesizer |
| GC Round | 1 |
| Date | 2026-03-31 |
| Input | 8 ideas (IDEA-1~8), 1 critique round |

---

## Input Summary

**Ideas generated**: 8 ideas across 5 dimensions (Prevention, Detection, Recovery, Protocol, Degradation)

**Critique verdicts**:

| Idea | Severity | Signal | Key Challenge |
|------|----------|--------|---------------|
| IDEA-1 | CRITICAL | REVISION_NEEDED | Circular dependency (probe assumes problem is solved); 2-3s mandatory delay; may worsen rate limiting |
| IDEA-2 | HIGH | REVISION_NEEDED | Arbitrary threshold (50 bytes/5s) with no empirical data; mid-stream retry risks content duplication |
| IDEA-3 | MEDIUM | CONVERGED (w/ notes) | Downstream compatibility unverified; protocol design incomplete |
| IDEA-4 | MEDIUM | CONVERGED (w/ notes) | Misclassifies intermittent as persistent; 60s collective penalty amplifies occasional failures |
| IDEA-5 | HIGH | REVISION_NEEDED | Truncated content (half-sentences, garbled) injects noise as context; implementation complexity underestimated |
| IDEA-6 | HIGH | REVISION_NEEDED | Fake content ("Processing your request...") deceives downstream; may corrupt real thinking output |
| IDEA-7 | LOW | CONVERGED (w/ notes) | SSE `event: error` non-standard; recommend `event: degrade` with structured payload |
| IDEA-8 | MEDIUM | CONVERGED (w/ notes) | Receipt sent after stream ends (res.end()); only observability, not real-time fix |

---

## Extracted Themes

### Theme 1: Upstream State Awareness (Detection/Prevention)
**Strength: 9/10**

All 8 ideas assume we need to detect upstream stream breaks earlier or more accurately. The approaches range from proactive pre-probing (IDEA-1, circular) to reactive byte velocity monitoring (IDEA-2). Supporting ideas: IDEA-1, IDEA-2, IDEA-4, IDEA-8.

**Conflict**: IDEA-1 tries to prevent before the request; IDEA-2/4/8 try to detect during/after. These are complementary but IDEA-1's circular assumption is fatal.

### Theme 2: Structured Stream Communication (Protocol)
**Strength: 8/10**

A consistent thread across IDEA-3, IDEA-7, IDEA-8 is that the SSE protocol currently carries no semantic metadata about stream health. Downstream receives raw chunks with no way to distinguish "early stream break" from "slow stream". Supporting ideas: IDEA-3, IDEA-7, IDEA-8.

**Conflict**: IDEA-3 and IDEA-8 have overlapping concerns (meta frames vs. receipt). IDEA-8's receipt is post-hoc, but the framing/fields could be unified with IDEA-3's meta frame design.

### Theme 3: Cascading Failure Prevention (Recovery)
**Strength: 6/10**

IDEA-4 and IDEA-5 address the risk of repeated failed requests amplifying downstream problems. Circuit breaker (IDEA-4) prevents hammering a failing upstream; context-preserving retry (IDEA-5) tries to improve retry success. Supporting ideas: IDEA-4, IDEA-5.

**Conflict**: IDEA-4's "all-or-nothing" circuit breaker causes collective punishment (all users get degraded for 60s). IDEA-5's truncated context injection can introduce noise.

### Theme 4: Response Guarantee Signals (Mitigation)
**Strength: 5/10**

IDEA-6 and IDEA-7 attempt to improve downstream's waiting experience by providing visible signals. IDEA-7 (semantic degradation) is well-scoped; IDEA-6 (fake content) is dangerous. Supporting ideas: IDEA-6, IDEA-7.

**Conflict**: IDEA-6's fake content directly contradicts the goal of preserving authentic responses. IDEA-7's SSE event type naming needs standardization.

---

## Conflict Resolution

### Conflict 1: Pre-probing (IDEA-1) vs. Reactive Detection
**Contradiction**: IDEA-1 assumes probe can predict whether the real request will succeed, but this is circular -- if upstream is breaking streams, the probe will break too.
**Resolution**: ABANDON IDEA-1's prediction model entirely. The probe concept could survive as a no-prediction side-channel (e.g., a `/health` endpoint that Cursor API itself exposes), but that is outside our control. No upstream state awareness before the real request is reliable.
**Verdict**: Do not proceed with pre-probing as a predictive mechanism.

### Conflict 2: Fixed vs. Adaptive Velocity Threshold (IDEA-2)
**Contradiction**: Fixed threshold (50 bytes/5s) will have high false positive rate on normal slow-start streams.
**Resolution**: Propose a two-phase adaptive approach: fast-detection phase (aggressive, catches genuine breaks) + confirmation phase (wider window before retry). This preserves early detection intent while reducing false positives.
**Verdict**: Reframe IDEA-2 as adaptive-threshold velocity monitor.

### Conflict 3: Circuit Breaker Collective Punishment (IDEA-4)
**Contradiction**: 60s global window with "all requests degrade" causes collateral damage to users whose requests would have succeeded.
**Resolution**: Drop the global all-or-nothing breaker. Instead, use per-request adaptive thresholds with optional half-open probing. This is fundamentally different from classic circuit breaker -- it's more like "degraded mode hints" per request.
**Verdict**: Reframe IDEA-4 as adaptive per-request degradation hints, not a hard global circuit breaker.

### Conflict 4: Truncated Context Injection (IDEA-5)
**Contradiction**: Short/garbled truncated content as system prompt context introduces noise.
**Resolution**: Add a minimum-length guard (e.g., >= 20 characters of alphanumeric content) before using partial response as context. Below threshold, fall back to default probe text.
**Verdict**: Reframe IDEA-5 as conditional-context retry with minimum-length guard.

### Conflict 5: Fake Content Injection (IDEA-6)
**Contradiction**: Artificial "Processing your request..." text deceives downstream, may corrupt Claude Code parsing.
**Resolution**: REMOVE fake content injection entirely. Replace with SSE comment-based progress signals (`: still processing...\n\n`), which are invisible to downstream content parsers but visible to SSE-aware clients.
**Verdict**: IDEA-6 should be replaced with SSE comment progress signals, not fake content.

### Conflict 6: Meta Frames (IDEA-3) vs. Receipt (IDEA-8)
**Contradiction**: Both propose SSE metadata mechanisms with overlapping scope.
**Resolution**: Unify into a single "SSE stream metadata protocol" with three event types: `degrade` (stream health), `status` (mid-stream state), and `receipt` (end-of-stream summary). All three share the same field schema for consistency.
**Verdict**: Merge IDEA-3 and IDEA-8 into unified SSE stream metadata protocol.

### Conflict 7: SSE Event Type Naming (IDEA-7)
**Contradiction**: `event: error` is non-standard SSE semantics; browsers/clients may mishandle.
**Resolution**: Use `event: degrade` for semantic clarity, with structured payload: `{ code, message, recoverable }`. This is more semantically accurate (the stream degraded, not that an HTTP error occurred).
**Verdict**: Adopt `event: degrade` per challenger recommendation.

---

## Complementary Grouping

| Group | Ideas | Rationale |
|-------|-------|-----------|
| Stream Metadata Protocol | IDEA-3 + IDEA-7 + IDEA-8 (merged) | Unified SSE protocol layer for stream state communication |
| Adaptive Recovery | IDEA-2 + IDEA-4 + IDEA-5 | Per-request adaptive detection + conditional retry improvement |
| Observability Layer | IDEA-3/7/8 (embedded) | All stream metadata events serve observability |

---

## Integrated Proposals

### Proposal 1: Unified SSE Stream Metadata Protocol
**Strength**: 8/10 (immediate value, low risk, backward compatible)

**Core concept**: Extend the SSE protocol with three structured event types that communicate stream health metadata without modifying content. Downstream clients that understand these events gain visibility; clients that ignore them continue working unchanged.

**Source ideas combined**: IDEA-3 (structured frames) + IDEA-7 (semantic degradation naming) + IDEA-8 (completeness receipt)

**Addressed challenges**:
- Challenger noted `event: error` is non-standard -> resolved by using `event: degrade`
- Challenger noted downstream compatibility unverified -> resolved by design that unknown event types are ignored by spec-compliant SSE parsers
- Challenger noted IDEA-3 and IDEA-8 overlap -> resolved by unifying into single protocol
- Challenger noted receipt is post-hoc -> resolved by separating `status` (mid-stream) from `receipt` (end-of-stream)

**Implementation sketch**:

```
// Three event types, same field schema:
event: degrade        // Stream degraded, fallback active
event: status         // Mid-stream state update
event: receipt        // End-of-stream summary

// Example payload:
event: degrade
data: {"code":"UPSTREAM_REFUSED","message":"Cursor API stream interrupted","recoverable":true,"bytes_so_far":128}

event: receipt
data: {"total_bytes":0,"stop_reason":"idle_timeout","has_tool_calls":false,"is_degraded":true,"retries_attempted":2}
```

**Feasibility score**: 8/10
**Innovation score**: 5/10 (protocol extension, not novel concept)

**Key benefits**:
- Downstream can distinguish degraded responses from empty responses
- Observable stream state without changing content behavior
- Backward compatible -- unknown events ignored by existing clients
- Enables future features (retry-aware clients, error UIs)

**Remaining risks**:
- Downstream may still not parse these events (Claude Code compatibility unknown)
- Requires changes in both handler.ts and openai-handler.ts
- Event schema needs versioning strategy for future fields

---

### Proposal 2: Adaptive Per-Request Degradation Hints
**Strength**: 6/10 (addresses root symptom but higher implementation risk)

**Core concept**: Replace the global circuit breaker with per-request adaptive detection. Each request independently evaluates upstream health using short rolling windows, adaptive thresholds, and optional half-open probing -- without affecting other concurrent requests.

**Source ideas combined**: IDEA-4 (circuit breaker, reframed) + IDEA-2 (velocity monitoring, adaptive) + IDEA-5 (context-preserving retry, conditional)

**Addressed challenges**:
- Challenger noted 60s collective punishment amplifies occasional failures -> resolved by removing global breaker, using per-request signals only
- Challenger noted arbitrary threshold (50 bytes/5s) -> resolved by two-phase adaptive approach: fast-detection phase (50 bytes/10s) followed by confirmation phase (200 bytes/20s) before retry
- Challenger noted truncated context injects noise -> resolved by minimum-length guard (>= 20 chars alphanumeric)
- Challenger noted mid-stream retry risks content duplication -> resolved by treating early termination as a signal to enter "degraded mode" on next request rather than mid-stream interrupt

**Implementation sketch**:

```
// Per-request adaptive detection (in cursor-client.ts):
class AdaptiveDegradationSignal {
  // Fast detection: 50 bytes in 10s window
  // If triggered: mark request as "degraded hint" for downstream
  // Confirmation: 200 bytes in 20s before confirming recovery

  // No global state - each request tracks independently
  // Optional half-open: after degraded hint, send one probe before full request
}

// Conditional context retry (in buildShortResponseRetryRequest):
if (partialContent.length >= 20 && hasAlphanumeric(partialContent)) {
  injectAsContext(partialContent)  // IDEA-5 refined
} else {
  useDefaultProbe()  // Fall back to clean probe
}
```

**Feasibility score**: 6/10
**Innovation score**: 7/10 (adaptive per-request approach is novel)

**Key benefits**:
- Eliminates collective punishment of global circuit breaker
- Reduces false positives via two-phase adaptive threshold
- Improves retry quality via conditional context injection
- Works independently per request, no cross-request contamination

**Remaining risks**:
- Adaptive threshold tuning still requires empirical production data
- Half-open probe adds complexity; could reintroduce the "probe fails" problem from IDEA-1
- Implementation touches cursor-client.ts, handler.ts, openai-handler.ts -- broader scope

---

## Coverage Analysis

| Original Idea | Status | Synthesis Mapping |
|--------------|--------|-----------------|
| IDEA-1 (Pre-stream Probe) | ABANDONED | Circular assumption; probe cannot predict real request outcome |
| IDEA-2 (Velocity Monitor) | REFINED | Proposal 2: adaptive two-phase threshold instead of fixed 50b/5s |
| IDEA-3 (Structured SSE) | MERGED | Proposal 1: unified into SSE stream metadata protocol |
| IDEA-4 (Circuit Breaker) | REFINED | Proposal 2: per-request adaptive hints instead of global breaker |
| IDEA-5 (Context Retry) | REFINED | Proposal 2: conditional context with minimum-length guard |
| IDEA-6 (Fake Content) | REPLACED | Proposal 1: SSE comment progress signals instead of fake content |
| IDEA-7 (Semantic Fallback) | MERGED | Proposal 1: `event: degrade` with structured payload |
| IDEA-8 (Completeness Receipt) | MERGED | Proposal 1: `event: receipt` in unified SSE protocol |

### Gaps Identified

1. **Root cause not addressed**: Neither proposal fixes the upstream stream breaks themselves. The system can only detect, signal, and mitigate -- upstream stability is outside our control.

2. **Downstream timeout behavior**: We assume downstream disconnects on empty/slow responses, but we don't know the exact timeout threshold. Understanding this could inform more precise detection windows.

3. **Production baseline data**: All thresholds (velocity, window sizes) are still heuristic. Real production data (normal byte velocity distributions, typical time-to-first-byte) would sharpen adaptive thresholds significantly.

---

## Recommended Implementation Order

1. **Phase 1: SSE Stream Metadata Protocol** (Proposal 1)
   - Lowest risk, immediate observability value
   - Works as prerequisite for Phase 2 (structured events provide the signaling layer)
   - Estimated: 1-2 days

2. **Phase 2: Adaptive Per-Request Degradation Hints** (Proposal 2)
   - Higher complexity, requires production data for threshold tuning
   - Build on Phase 1's SSE metadata layer for status reporting
   - Estimated: 3-5 days, with iterative tuning

---

## Quality Checks

| Check | Result | Notes |
|-------|--------|-------|
| Proposal count >= 1 | PASS | 2 proposals generated |
| Theme count >= 2 | PASS | 4 themes extracted (upstream awareness, structured comms, cascading prevention, response guarantees) |
| All conflicts documented | PASS | 7 conflicts identified and resolved |
| Each idea addressed | PASS | All 8 ideas mapped (2 abandoned, 6 refined/merged) |
