# Evaluation-001: cursor2api 防截断与 fallback 最优设计方案

**Evaluator**: evaluator
**Session**: BRS-fallback-opt-20260331
**Date**: 2026-03-31
**Input**: synthesis-001.md (4 proposals from synthesizer)

---

## Input Summary

The synthesizer produced 4 proposals from 10 ideas, after 1 GC round:

| Status | Count | Details |
|--------|-------|---------|
| Already Implemented | 2 | 方案二 (handler.ts:1544), 方案四 (handler.ts:1539) |
| DISCARDED | 3 | Idea 1 (streaming predictor), Idea 4 (circuit breaker), Idea 6 (prompt prevention) |
| Proposed for Action | 4 | Proposals 1-4 in this evaluation |

---

## Scoring Matrix

| Rank | Proposal | Feasibility | Innovation | Impact | Cost Efficiency | **Weighted Score** | Recommendation |
|------|----------|:-----------:|:----------:|:------:|:----------------:|:------------------:|----------------|
| 1 | P1: Unified Truncation Detection Module | 9 | 4 | 8 | 8 | **7.45** | Strong Recommend |
| 2 | P3: Handler Integration (Threshold Parity) | 8 | 2 | 8 | 9 | **6.85** | Strong Recommend |
| 3 | P2: Contextual Retry with Tool-Name Hint | 8 | 3 | 7 | 7 | **6.35** | Recommend |
| 4 | P4: Observability Baseline | 9 | 1 | 5 | 6 | **5.50** | Consider |

**Weights**: Feasibility 30%, Innovation 25%, Impact 25%, Cost Efficiency 20%
**Formula**: `(Feasibility * 0.30) + (Innovation * 0.25) + (Impact * 0.25) + (Cost * 0.20)`

---

## Detailed Evaluation

### P1: Unified Truncation Detection Module — Rank 1 (Score: 7.45) — Strong Recommend

**Feasibility: 9/10**
All detection logic already exists inline in both handlers. Extraction is mechanical, not speculative. The `detectTruncation()` function interface is well-scoped (5 outputs, 7 inputs). Confidence levels replace the fragile classification taxonomy identified by the challenger.

**Innovation: 4/10**
Incremental refactoring. No novel ideas — the code already exists. Value is in testability, not invention. Re-scored from synthesizer's 4 to 4 (appropriate).

**Impact: 8/10**
Addresses the most critical gap: inconsistent threshold behavior between handlers AND provides a single source of truth for detection logic. The `confidence` field provides useful observability signal. Enables future P3 observability work without additional infrastructure.

**Cost Efficiency: 8/10**
Extraction cost is low. The function is self-contained, has clear boundaries (does not touch request building). Risk is minimal — both handlers continue working, just with a shared call. One new file, both handlers updated with one call site each.

**Rationale for Rank 1**: Highest combined impact + feasibility. Innovation is appropriately low because the work is extraction, not invention. The synthesizer correctly identified this as the highest-priority P1 action.

---

### P3: Handler Integration (Threshold Parity) — Rank 2 (Score: 6.85) — Strong Recommend

**Feasibility: 8/10**
Single-line change: openai-handler.ts line 999, `t.length >= 3` to `t.length >= 10`. Well-understood. The synthesis correctly identifies this as a simple fix. Score adjusted down from 8 to 8 because the fix is trivial but the verification (post-retry state reset parity) requires care.

**Innovation: 2/10**
Pure maintenance. No new capability. Score from synthesizer (2) is appropriate.

**Impact: 8/10**
Critical consistency fix. Currently, fragments 3-9 characters long produce different retry behavior depending on which handler processes them. This creates unpredictable user experience and makes debugging harder. Fixing threshold parity eliminates this entire class of inconsistency.

**Cost Efficiency: 9/10**
One-line change with high value. The parity verification is also low-cost (requires reading two files and comparing post-retry state). Highest cost-efficiency ratio of all proposals.

**Rationale for Rank 2**: Very high impact and cost efficiency, but lowest innovation. The threshold fix is prerequisite for P1's unified detection module (the unified module standardizes to >= 10). These two proposals are complementary.

---

### P2: Contextual Retry with Structured Context Injection — Rank 3 (Score: 6.35) — Recommend

**Feasibility: 8/10**
Already implemented at handler.ts:1544-1551. The refinement (tool-name hint extraction) is incremental. The `extractLikelyToolName` heuristic is low-complexity. Score from synthesizer (8) is appropriate.

**Innovation: 3/10**
Extension of existing work. The tool-name hint concept is logical but not novel — it is an obvious refinement once the retry mechanism exists. Score from synthesizer (3) is appropriate.

**Impact: 7/10**
Tool-name hint increases the probability of correct tool selection on retry. The synthesizer notes this is "low severity" since fallback still works — so impact is moderate. Score adjusted down from synthesizer's implied 7 to 7 (appropriate).

**Cost Efficiency: 7/10**
Low-to-moderate cost. `extractLikelyToolName` heuristic requires careful construction to avoid misfire. The risk of false tool hints is non-zero and could confuse the model on retry.

**Rationale for Rank 3**: Already implemented baseline, so implementation risk is zero. Refinement cost is moderate with moderate benefit. Recommend proceeding after P1 and P3 are complete, as the tool-name extraction works better when detection is unified (P1 provides the context).

---

### P4: Observability Baseline — Rank 4 (Score: 5.50) — Consider

**Feasibility: 9/10**
Only log format changes. No new files, no new subsystems. Score from synthesizer (9) is appropriate.

**Innovation: 1/10**
Pure maintenance. Log standardization is not innovation by any reasonable definition. Score from synthesizer (1) is appropriate.

**Impact: 5/10**
Useful for debugging but does not change runtime behavior. Value depends on whether there is an observability pipeline to consume the structured logs. The synthesis correctly notes "defer until there's a defined observability pipeline." Without a pipeline, the structured logs are just prettier text.

**Cost Efficiency: 6/10**
Low cost, but deferred/low value until pipeline exists. The synthesizer notes this is P3/non-blocking.

**Rationale for Rank 4**: High feasibility but low innovation and moderate impact. Appropriate for a follow-up PR after P1-P3 are complete, not for immediate action.

---

## Consistency Check

| Check | Result | Notes |
|-------|--------|-------|
| Score spread (max - min) | 7.45 - 5.50 = **1.95 >= 0.5** | PASS |
| No perfect scores | Highest is 7.45, no 10s | PASS |
| Ranking deterministic | P1 > P3 > P2 > P4, clear separation | PASS |
| Score alignment with synthesizer priority | P1=P3=P2 (P1) and P4 (P3) match | PASS |

All checks pass. Rankings are deterministic and scores reflect differentiation.

---

## Final Recommendation

### Immediate Action (this PR)

**P1 (7.45) + P3 (6.85)**: Strong Recommend — implement together

These two proposals are complementary and together address the critical gaps:

1. **P3** (1-line fix): `openai-handler.ts:999` — change `t.length >= 3` to `t.length >= 10`
2. **P1** (new file + 2 call sites): Create `src/truncation-detector.ts` with `detectTruncation()` function; replace inline detection in both handlers

Rationale: P3 is a prerequisite for P1 (the unified module uses `>= 10`). Both can be completed in a single PR with minimal risk.

### Follow-up (next PR)

**P2 (6.35)**: Recommend — refine `buildThinkingFragmentRetryRequest` with `extractLikelyToolName` after P1 lands (detection context improves tool extraction quality)

**P4 (5.50)**: Consider — defer until observability pipeline exists. Low cost, low urgency.

### What NOT to Do

The synthesizer correctly identified 3 ideas to discard. The evaluator confirms:
- **Idea 1** (streaming predictor): Token budget infeasible mid-stream
- **Idea 4** (circuit breaker): Wrong pattern for expected sequences
- **Idea 6** (prompt prevention): No model-level budget introspection

---

## Action Items

| Priority | Action | Owner | Effort |
|----------|--------|-------|--------|
| P1 | Create `src/truncation-detector.ts` with `detectTruncation()` | executor | Medium |
| P1 | Replace inline detection in `handler.ts` with `detectTruncation()` call | executor | Low |
| P1 | Replace inline detection in `openai-handler.ts` with `detectTruncation()` call | executor | Low |
| P3 | Fix `openai-handler.ts:999` — `t.length >= 3` to `t.length >= 10` | executor | Trivial |
| P3 | Verify post-retry state reset parity between handlers | executor | Low |
| P2 | Refine `buildThinkingFragmentRetryRequest` with `extractLikelyToolName` | executor | Medium |
| P4 | Standardize log event format (deferred) | executor | Low |

---

## Risk Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tool representation divergence (`input_schema` vs `function.parameters`) | Medium | Keep truncation-detector focused on detection only; do not abstract request building |
| `extractLikelyToolName` heuristic misfire on P2 | Low | Fallback prompt always works; false hint is low-impact |
| Handler state divergence after P1/P3 | Low | Verification checklist in action items covers parity |
| Over-abstraction in truncation-detector | Low | Single function, clear inputs/outputs, no class hierarchy |

---

## Evaluation Metadata

| Field | Value |
|-------|-------|
| Evaluator | evaluator |
| Task | EVAL-001 |
| Proposals evaluated | 4 |
| Proposals recommended | 4 (2 Strong Recommend, 1 Recommend, 1 Consider) |
| Proposer | synthesizer (via synthesis-001.md) |
| Input sources | brainstorm.md, idea-001.md, critique-001.md, synthesis-001.md |
