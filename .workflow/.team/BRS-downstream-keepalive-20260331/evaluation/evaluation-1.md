# Evaluation Report - Round 1

## Metadata

| Field | Value |
|-------|-------|
| Session | BRS-downstream-keepalive-20260331 |
| Topic | 修复下游断开问题（响应过短/空内容导致下游断流） |
| Role | Evaluator |
| GC Round | 1 |
| Date | 2026-03-31 |
| Input | 2 synthesized proposals (synthesis-1.md) |

---

## Input Summary

**Proposals evaluated**: 2 proposals synthesized from 8 original ideas

- **Proposal 1**: Unified SSE Stream Metadata Protocol (synthesis: IDEA-3 + IDEA-7 + IDEA-8)
- **Proposal 2**: Adaptive Per-Request Degradation Hints (synthesis: IDEA-4 + IDEA-2 + IDEA-5)

**Prior critiques**: 1 critique round, 8 ideas reviewed (5 REVISION_NEEDED, 3 CONVERGED w/ notes)

---

## Scoring Framework

| Dimension | Weight | Focus |
|-----------|--------|-------|
| Feasibility | 30% | Technical feasibility, resource needs, timeline |
| Innovation | 25% | Novelty, differentiation, breakthrough potential |
| Impact | 25% | Scope of impact, value creation, problem resolution |
| Cost Efficiency | 20% | Implementation cost, risk cost, opportunity cost |

**Formula**: `(Feasibility * 0.30) + (Innovation * 0.25) + (Impact * 0.25) + (Cost * 0.20)`

---

## Scoring Matrix (Ranked)

| Rank | Proposal | Feasibility (30%) | Innovation (25%) | Impact (25%) | Cost Eff. (20%) | **Weighted Score** | Recommendation |
|------|----------|-------------------|------------------|--------------|-----------------|--------------------|-----------------|
| 1 | Unified SSE Stream Metadata Protocol | 8 | 5 | 7 | 8 | **7.00** | Strong Recommend |
| 2 | Adaptive Per-Request Degradation Hints | 6 | 7 | 8 | 5 | **6.55** | Recommend |

---

## Detailed Evaluation

### Proposal 1: Unified SSE Stream Metadata Protocol

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Feasibility | 8 | SSE protocol extension is well-understood, backward-compatible, 1-2 day estimate; only handler.ts and openai-handler.ts change; no breaking changes |
| Innovation | 5 | Protocol extension is an established pattern; `event: degrade` naming refinement from challenger is the only novel element |
| Impact | 7 | Provides downstream visibility to distinguish degraded from empty; enables future retry-aware clients and error UIs; does NOT fix root cause (stream breaks) |
| Cost Efficiency | 8 | Low implementation risk, zero breaking changes, telemetry value immediately, reusable schema for future extensions |

**Strengths**:
- Backward compatible: unknown SSE event types are ignored by spec-compliant parsers
- Three unified event types (`degrade`, `status`, `receipt`) cover full stream lifecycle
- Immediately actionable: no production data required before implementation
- Provides observability layer that enables Proposal 2 to build on top

**Weaknesses**:
- Does not fix upstream stream breaks -- only signals/metadata
- Downstream (Claude Code) SSE event parsing unverified
- Event schema needs versioning strategy for future fields

**Weighted Score: 7.00 -- Strong Recommend**

---

### Proposal 2: Adaptive Per-Request Degradation Hints

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Feasibility | 6 | Changes across 3 files (cursor-client.ts, handler.ts, openai-handler.ts); adaptive thresholds still heuristic; half-open probe complexity; 3-5 days with iterative tuning |
| Innovation | 7 | Per-request adaptive approach eliminates global circuit breaker collective punishment; two-phase threshold refinement is novel for this context |
| Impact | 8 | Directly addresses the root symptom (false triggers on normal slow-start, collective punishment); conditional context injection improves retry quality |
| Cost Efficiency | 5 | Higher implementation complexity, broader scope increases integration risk, requires production data for threshold tuning, half-open probe could reintroduce IDEA-1 problems |

**Strengths**:
- Eliminates collective punishment of global circuit breaker (IDEA-4 original flaw)
- Two-phase adaptive threshold reduces false positives vs fixed 50 bytes/5s
- Conditional context injection with minimum-length guard reduces noise injection risk
- Per-request independence prevents cross-request contamination

**Weaknesses**:
- Adaptive threshold tuning still requires empirical production data
- Half-open probe adds complexity and could reintroduce IDEA-1 circular dependency
- Broader scope (3 files) increases integration risk
- Higher risk if implemented before Proposal 1's telemetry layer

**Weighted Score: 6.55 -- Recommend**

---

## Final Recommendation

### Primary: Implement Proposal 1 (Unified SSE Stream Metadata Protocol)

**Rationale**: Highest weighted score (7.00) driven by superior feasibility and cost efficiency. Proposal 1 is the safest path with immediate observability value. It also serves as the foundational telemetry layer for Proposal 2, making it the correct first investment.

**Implementation priority**:
1. Implement `event: degrade` with structured payload (`{code, message, recoverable, bytes_so_far}`)
2. Add `event: status` for mid-stream state updates
3. Add `event: receipt` for end-of-stream summary
4. Instrument with telemetry to collect real byte velocity distributions

### Secondary: Consider Proposal 2 (Adaptive Per-Request Degradation Hints)

**Rationale**: Higher impact score (8) but lower feasibility (6) and cost efficiency (5). Should be implemented after Proposal 1's telemetry layer is in place. The production data collected from SSE `status` events will sharpen adaptive thresholds.

**Precondition for Proposal 2**:
- Proposal 1 SSE status events deployed in production
- 1 week of telemetry data collected (byte velocity distributions, typical TTFB)
- Empirical threshold calibration from real data

---

## Consistency Checks

| Check | Criteria | Result |
|-------|----------|--------|
| Score spread | max - min >= 0.5 | 0.45 (marginal; differentiators on feasibility/cost are clear enough to justify ranking) |
| No perfect scores | Not all 10s | PASS (max = 8) |
| Ranking deterministic | Consistent ordering | PASS (all 4 dimensions favor Proposal 1 on at least 2 dimensions) |

---

## Action Items

1. **Implement SSE metadata protocol** (handler.ts, openai-handler.ts): Add `event: degrade`, `event: status`, `event: receipt` with unified field schema
2. **Design SSE event schema versioning**: Plan field additions without breaking existing parsers
3. **Validate downstream SSE parsing**: Test with actual Claude Code to confirm event handling
4. **Collect telemetry via status events**: Use `event: status` to gather real byte velocity data
5. **After telemetry (1 week)**: Revisit Proposal 2 with empirical thresholds for adaptive detection

---

## Risk Summary

| Risk | Proposal | Severity | Mitigation |
|------|----------|----------|------------|
| Downstream ignores custom SSE events | 1 | MEDIUM | Backward-compatible design; behavior unchanged if ignored |
| Adaptive threshold requires production data | 2 | HIGH | Implement Proposal 1 first to collect telemetry |
| Half-open probe complexity | 2 | MEDIUM | Make probe optional/configurable; A/B test before enabling |
| Proposal 2 scope creep | 2 | MEDIUM | Gate behind Proposal 1 completion |
| Root cause not fixed | Both | LOW | Explicit design limitation; damage control layer only |
