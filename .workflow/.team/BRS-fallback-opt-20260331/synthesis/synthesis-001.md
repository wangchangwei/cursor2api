# Synthesis-001: cursor2api 防截断与 fallback 最优设计方案

**Synthesizer**: synthesizer
**Session**: BRS-fallback-opt-20260331
**Date**: 2026-03-31
**Input**: 10 ideas from brainstorm.md + idea-001.md, challenged by critique-001.md (1 GC round)

---

## Input Summary

### Ideas Reviewed (10 total)

| Source | Idea | Challenge Status |
|--------|------|-----------------|
| brainstorm.md | 方案一 ResponseIntent Classifier | CONVERGED (MEDIUM caveat) |
| brainstorm.md | 方案二 thinking_only Contextual Retry | CONVERGED (already implemented) |
| brainstorm.md | 方案三 Shared ResponseValidator | CONVERGED (LOW caveat) |
| brainstorm.md | 方案四 stopReason Signal Priority | CONVERGED (already implemented, MEDIUM caveat) |
| idea-001 | Idea 1 流式截断预测器 | DISCARD (CRITICAL) |
| idea-001 | Idea 2 Adaptive Token Budget | CONVERGED (low priority) |
| idea-001 | Idea 3 Observability + Regression | CONVERGED (post-P0) |
| idea-001 | Idea 4 Circuit Breaker | DISCARD (HIGH) |
| idea-001 | Idea 5 Unified Detection Logic | CONVERGED (P3 follow-up) |
| idea-001 | Idea 6 Prompt-level Prevention | DISCARD (HIGH) |

**DISCARD**: 3 ideas (Ideas 1, 4, 6) — fundamental architectural incompatibilities
**CONVERGED**: 7 ideas with caveats

### Already Implemented (2 of 7)
- **方案二**: handler.ts:1544-1551 — `buildThinkingFragmentRetryRequest` + contextual retry
- **方案四**: handler.ts:1539-1540 — `upstreamFinishReason === 'max_tokens'` in detection

---

## Extracted Themes

### Theme 1: Signal Convergence — Multiple Signals, One Decision
**Strength: 9/10** — Both 方案四 and 方案二 rely on combining `upstreamFinishReason` (from Cursor SSE) with heuristic string patterns. The challenge identifies that neither signal alone is definitive.

Supporting ideas: 方案四 (stopReason), 方案二 (thinking_only retry), 方案一 (ResponseIntent)

**Key insight**: The strongest detection combines three signals:
1. `upstreamFinishReason === 'max_tokens'` (Cursor SSE — useful but not infallible)
2. Response length + punctuation heuristics (fallback when stopReason unavailable)
3. Presence/absence of `tool_use` block in SSE events

### Theme 2: Contextual Retry Over Blind Fallback
**Strength: 8/10** — The idea that retrying with the model's own thinking fragment is superior to synthesizing empty parameter calls is unanimous across all reviewers.

Supporting ideas: 方案二, 方案一

**Key insight**: Only use empty fallback as last resort (after retry exhaustion).

### Theme 3: Handler Divergence — Maintenance Burden
**Strength: 7/10** — Both handlers now implement similar logic but with meaningful differences.

Supporting ideas: 方案三, Idea 5

**Key insight**: The divergence is not just in detection logic but in thresholds (handler.ts uses `t.length >= 10` for contextual retry; openai-handler.ts uses `t.length >= 3`).

### Theme 4: Abstraction vs. Over-engineering
**Strength: 5/10** — The debate over whether a "ResponseIntent classifier" adds value or indirection.

Supporting ideas: 方案一, 方案三

**Key insight**: Reframe as "testable detection logic extraction" not "classifier." The value is in testability and single source of truth, not a classification taxonomy.

---

## Conflict Resolution

### Conflict 1: stopReason Reliability
**Contradiction**: 方案四 claims `upstreamFinishReason` is the "most reliable" signal; the challenge correctly identifies it comes from Cursor SSE, not Claude API, and may not always be accurate.

**Resolution**: Reframe 方案四 as "complementary signal" (precision) + heuristic fallback (recall). Neither alone is sufficient. Both must coexist.

### Conflict 2: Handler Threshold Inconsistency
**Contradiction**: handler.ts uses `t.length >= 10` for contextual retry (line 1544); openai-handler.ts uses `t.length >= 3` (line 999). This creates different retry behavior for fragments 3-9 chars.

**Resolution**: Standardize to `t.length >= 10` across both handlers. 3 chars is too short to provide meaningful context for retry.

### Conflict 3: Classification vs. Extraction Framing
**Contradiction**: 方案一 presents a "ResponseIntent classifier" with a priority-ordered if/else chain; the challenge identifies this as fragile when responses match multiple patterns simultaneously.

**Resolution**: Abandon the classification taxonomy (6 intent types) in favor of a simple detection function with clear input/output. The function should NOT claim to classify intent — it should output a structured decision with confidence level.

---

## Integrated Proposals

### Proposal 1: Unified Truncation Detection Module (P1) — HIGHEST PRIORITY

**Core Concept**: Extract the detection logic from both handlers into a shared `truncation-detector.ts` module. This is NOT a "ResponseIntent classifier" — it is a decision function with three outputs: detection type, confidence, and recommended action.

**Source ideas combined**: 方案一 + 方案三 + Idea 5

**Implementation design**:

```typescript
// src/truncation-detector.ts

export interface TruncationDecision {
  type: 'partial_tool' | 'thinking_only' | 'empty' | 'valid_tool' | 'valid_text';
  confidence: 'high' | 'medium' | 'low';
  reason: string;  // For debugging/logging
  retryStrategy: 'contextual_retry' | 'probe_retry' | 'fallback' | 'none';
}

export interface TruncationInput {
  fullResponse: string;
  hasTools: boolean;
  hasToolCalls: boolean;
  upstreamFinishReason?: string;  // optional, from Cursor SSE
  retryCount: number;
  maxRetries: number;
}

export function detectTruncation(input: TruncationInput): TruncationDecision {
  const { fullResponse, hasTools, hasToolCalls, upstreamFinishReason, retryCount, maxRetries } = input;
  const t = fullResponse.trim();

  // High confidence: tool call present
  if (hasToolCalls) {
    return { type: 'valid_tool', confidence: 'high', reason: 'tool call found', retryStrategy: 'none' };
  }

  // High confidence: upstream signals truncation
  if (hasTools && upstreamFinishReason === 'max_tokens' && !hasToolCalls) {
    const isMeaningful = t.length >= 10;
    return {
      type: isMeaningful ? 'thinking_only' : 'empty',
      confidence: 'high',
      reason: `upstreamFinishReason=max_tokens, ${t.length} chars`,
      retryStrategy: isMeaningful && retryCount < maxRetries ? 'contextual_retry' : 'fallback',
    };
  }

  // Medium confidence: heuristic patterns
  if (hasTools && !hasToolCalls && t.length > 0) {
    const isThinkingFragment = t.length < 200 && /[：:,，。.…]$/.test(t);
    const isEmpty = t.length < 3 && !t.match(/\d/);

    if (isThinkingFragment && t.length >= 10) {
      return {
        type: 'thinking_only',
        confidence: 'medium',
        reason: `heuristic thinking fragment (${t.length} chars, ends with punct)`,
        retryStrategy: retryCount < maxRetries ? 'contextual_retry' : 'fallback',
      };
    }
    if (isThinkingFragment && t.length < 10) {
      return {
        type: 'empty',
        confidence: 'medium',
        reason: `too short for contextual retry (${t.length} chars)`,
        retryStrategy: 'probe_retry',
      };
    }
    if (isEmpty) {
      return {
        type: 'empty',
        confidence: 'medium',
        reason: 'response empty or near-empty',
        retryStrategy: 'probe_retry',
      };
    }
  }

  // Valid text response
  return { type: 'valid_text', confidence: 'low', reason: 'no truncation signals', retryStrategy: 'none' };
}
```

**Key decisions encoded**:
1. Standardized threshold: `t.length >= 10` for contextual retry (fixes openai-handler.ts inconsistency)
2. `upstreamFinishReason` treated as high-confidence complementary signal
3. No classification taxonomy — just decision + confidence + strategy
4. Both handlers call this function; they only differ in how they BUILD the retry request (different request shapes)

**Feasibility score: 9/10** — Logic already exists in both handlers; this is extraction + cleanup
**Innovation score: 4/10** — Incremental refactoring, not novel ideas

**Addressed challenges**:
- Challenger's concern about "1:1 classification fragility" → addressed by using confidence levels instead of deterministic types
- Challenger's concern about over-abstraction → addressed by keeping the module simple (one function, no class hierarchy)
- openai-handler.ts:999 threshold inconsistency → fixed by standardizing to >= 10

**Key benefits**: Single source of truth, testable in isolation, consistent behavior across handlers
**Remaining risks**: Tool representation abstraction still needed (`input_schema` vs `function.parameters`) — handled by keeping this module focused on detection only, not request building

---

### Proposal 2: Contextual Retry with Structured Context Injection (P1)

**Core Concept**: Refine the already-implemented `buildThinkingFragmentRetryRequest` to also extract the in-progress tool call schema (if visible in the thinking fragment) and inject it as guidance in the retry prompt.

**Source ideas combined**: 方案二 (already implemented, with refinement)

**Implementation refinement**:

The current implementation (handler.ts:1544-1551) injects the thinking fragment + a generic "请继续完成工具调用" prompt. The refinement:

```typescript
function buildThinkingFragmentRetryRequest(
  body: AnthropicRequest,
  thinkingFragment: string,
  availableTools?: Tool[]
): AnthropicRequest {
  // Try to extract tool name hints from the thinking fragment
  const toolNameHint = extractLikelyToolName(thinkingFragment, availableTools);
  const continuationPrompt = toolNameHint
    ? `你之前的回复被截断了。你正在调用工具: ${toolNameHint}。请直接完成该工具调用，输出完整的 \`\`\`json action 块，包含真实参数。`
    : `你之前的回复被截断了。请直接完成工具调用，输出完整的 \`\`\`json action 块。`;

  return {
    ...body,
    messages: [
      ...body.messages,
      { role: 'assistant', content: thinkingFragment },
      { role: 'user', content: continuationPrompt },
    ],
  };
}
```

**Feasibility score: 8/10** — Already implemented; this is incremental refinement
**Innovation score: 3/10** — Extension of existing work

**Key benefits**: Tool-name hint increases probability of correct tool selection on retry
**Remaining risks**: `extractLikelyToolName` heuristic could misfire; low severity since fallback still works

---

### Proposal 3: Handler Integration — Unified Entry Point (P2)

**Core Concept**: handler.ts and openai-handler.ts have different request shapes but identical truncation detection logic. After extracting the detection module (Proposal 1), the remaining divergence is in request building (tool representation). Rather than abstracting tool representation, consolidate by ensuring BOTH handlers receive the same detection signal and apply identical retry logic.

**Source ideas combined**: Idea 5, 方案三, 方案四

**Specific inconsistencies to fix**:

1. **Threshold mismatch** (openai-handler.ts:999 uses >= 3, handler.ts:1544 uses >= 10) — fix openai-handler.ts
2. **openai-handler.ts missing `t.length < 200` check** — openai-handler.ts line 995 uses `t.length < 200` already, good
3. **openai-handler.ts retry logic flow** (line 1007) recalculates `t2` after retry but handler.ts resets more state — verify parity
4. **openai-handler.ts:999** — `upstreamFinishReason` check is present at line 996, consistent with handler.ts

**Action items**:
- [ ] openai-handler.ts line 999: change `t.length >= 3` to `t.length >= 10`
- [ ] openai-handler.ts: after contextual retry, verify `hybridAlreadySentText` reset parity with handler.ts
- [ ] Consider extracting `buildThinkingFragmentRetryRequest` to shared module (same function works for both since it takes `AnthropicRequest`)

**Feasibility score: 8/10** — Simple fixes, well-understood
**Innovation score: 2/10** — Maintenance refactoring

---

### Proposal 4: Observability Baseline (P3, Non-blocking)

**Core Concept**: Add minimal structured logging around the detection/retry cycle without introducing a metrics subsystem. The existing `log.warn` calls are sufficient; we just need to standardize their format.

**Source ideas combined**: Idea 3

**Key insight from challenge**: Existing structured logging already covers key events. The gap is consistency and machine-readability, not adding new events.

**Action items**:
- [ ] Standardize all retry-related log events to include: `event_type`, `fragment_length`, `upstreamFinishReason`, `retry_count`, `decision_type`
- [ ] Add a single `summary` event at stream end: `{ truncation_detected, contextual_retries, fallback_used, final_response_type }`
- [ ] No new metrics subsystem — defer until there's a defined observability pipeline

**Feasibility score: 9/10** — Only log format changes
**Innovation score: 1/10** — Pure maintenance

---

## Coverage Analysis

### What remains to be done (after 方案二 and 方案四 are implemented)

| Gap | Proposal | Priority | Status |
|-----|----------|---------|--------|
| Handler threshold inconsistency | Proposal 3 | P1 | Fix openai-handler.ts:999 |
| Unified detection module | Proposal 1 | P1 | Build truncation-detector.ts |
| Tool-name hint in retry prompt | Proposal 2 | P1 | Refine existing implementation |
| Observability baseline | Proposal 4 | P3 | Non-blocking |

### What NOT to do
- Streaming truncation predictor (Idea 1) — fundamentally infeasible
- Circuit breaker (Idea 4) — wrong pattern
- Prompt-level prevention (Idea 6) — model lacks budget introspection
- Adaptive token budget heuristic (Idea 2) — P0 stopReason approach already handles budget concerns

---

## Implementation Roadmap

### Immediate (this session)
1. Fix openai-handler.ts:999: `t.length >= 3` → `t.length >= 10`
2. Create `src/truncation-detector.ts` with `detectTruncation()` function
3. Replace inline detection in both handlers with `detectTruncation()` call
4. Add structured summary log at stream end

### Follow-up (separate PR)
5. Refine `buildThinkingFragmentRetryRequest` with tool-name hint extraction
6. Verify parity of post-retry state reset between handlers
