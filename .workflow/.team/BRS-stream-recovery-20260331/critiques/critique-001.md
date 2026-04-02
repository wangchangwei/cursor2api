# Critique: 下游断流主动恢复机制 (GC Round 0)

**Reviewer**: challenger
**Date**: 2026-03-31
**Ideas Reviewed**: IDEA-1 through IDEA-8

---

## Preamble: Ground Truth from Existing Code

Before challenging each idea, the following facts from the existing codebase are **non-negotiable constraints**:

1. **"check" already exists**: `handler.ts:873` sends a user message prefixed with "check" plus a Proxy hint (`[Proxy: the previous assistant reply was empty or too short...]`). "check" is NOT a bare prompt -- it is the semantic signal in a structured user message.

2. **"continue" already exists**: The continuation mechanism (`shouldAutoContinueTruncatedToolResponse`) already drives follow-up requests that functionally act as "continue" semantics.

3. **Precise truncation signal exists**: `stop_reason === 'max_tokens'` from SSE events is the definitive upstream truncation indicator. It is already used in `truncation-detector.ts:106`.

4. **truncation-detector.ts already exists**: A unified truncation detection module already covers code block closure, JSON action blocks, HTML tags, punctuation endings, and `stop_reason` analysis.

5. **The retry stack is already multi-layered**: refusal retry, short-response check probe, thinking-fragment continuation, max_auto_continue loop. Each layer is already independent with its own counter and strategy.

All ideas must be evaluated against this existing machinery -- reinvention of existing code is a CRITICAL-level flaw.

---

## Per-Idea Challenges

### IDEA-1: 语义锚点检测法 (Semantic Anchor Detection)

**Angle**: 断流检测模式

**Challenge 1 — CRITICAL: False Positive Risk (Assumption Invalidity)**

The idea assumes complete responses always end with explicit completion anchors ("done", "complete", closed code blocks, sentence-ending punctuation). This assumption is demonstrably false:

- Prose responses often end mid-word or mid-sentence in conversational responses (e.g., "Sure, let me know if you need any" without "help")
- Code responses frequently end inside a function body without explicit closure
- A single emoji or "ok" response has no anchor at all
- Normal API responses can legitimately end with unclosed structures in partial/cancelled sessions

Implementing this would create massive false positives -- triggering recovery on perfectly valid short or natural completions.

**Challenge 2 — CRITICAL: Reinvention of Existing Code**

The existing `isTruncated()` function in `truncation-detector.ts` already detects the strongest anchor signals: unclosed code blocks, unclosed JSON action blocks, unclosed HTML tags, and punctuation endings. IDEA-1 proposes a superset that includes these exact same signals plus weaker semantic ones. The overlap is 80%. The incremental value of semantic anchors is marginal compared to the false positive risk they introduce.

**Challenge 3 — HIGH: "90% detection accuracy" claim is unsubstantiated**

No data is cited for this number. In practice, semantic anchor matching on free-form text has notoriously unstable accuracy -- it varies dramatically by language, domain, and response type. Without empirical validation on real Cursor API traffic, this number is optimistic fiction.

**Severity: CRITICAL**

---

### IDEA-2: 双层检测策略 (Two-Layer Detection)

**Challenge 1 — MEDIUM: Layer 1 duplicates existing `isTruncated()`**

Layer 1 (character-level rules: punctuation, code block closure) is functionally identical to the existing `isTruncated()` in `truncation-detector.ts`. Building a second "QuickCheck" layer alongside it creates two sources of truth for the same detection logic, guaranteed to diverge over time.

**Challenge 2 — MEDIUM: DeepCheck adds complexity with marginal return**

The semantic analyzer for "unfinished enumeration" or "missing conclusion" is essentially a lightweight LLM classifier. This is expensive, slow, and unreliable for real-time inference. The described "LLM classification or rule matching" rule matching degrades to the same heuristics in IDEA-1 with all its problems.

**Challenge 3 — MEDIUM: The 80% QuickCheck pass-through target is unvalidated**

No evidence this target is achievable. Most streaming completions will likely fail Layer 1 checks if Layer 1 is based on strict punctuation rules.

**Severity: MEDIUM**

---

### IDEA-3: check 与 continue 语义分层设计

**Challenge 1 — CRITICAL: Assumption about Cursor API differentiation is unverified**

The entire idea rests on the assumption that "Cursor upstream has differentiated response logic for check vs continue." There is **zero evidence in the codebase** that Cursor treats these differently. The Cursor API is not Anthropic's Claude API -- it is a proxy to unknown upstream models. Sending "check" vs "please continue" as the content of a user message likely produces identical behavior, because what matters is the message structure and the Proxy hint, not the first token.

In the existing code, both "check" and the continuation strategy use the same message-append approach with different context injection. The semantic difference described in IDEA-3 does not exist at the protocol level.

**Challenge 2 — MEDIUM: Watchful vs Aggressive is already implemented differently**

The "WATCHFUL (check)" vs "AGGRESSIVE (continue)" distinction maps directly to the existing `probe` strategy (check probe for near-empty responses, handler.ts:1510) and `continuation` strategy (thinking fragment injection for partial tool calls, handler.ts:1544). The ideas are functionally redundant with existing mechanisms -- just renamed.

**Challenge 3 — LOW: "check message content can be empty or minimal" is risky**

Bare "check" without the Proxy hint is semantically ambiguous. The existing code always pairs "check" with a `[Proxy: ...]` instruction. Sending minimal/no content invites unpredictable upstream behavior.

**Severity: HIGH**

---

### IDEA-4: 渐进式恢复时机 (Progressive Recovery Timing)

**Challenge 1 — MEDIUM: T1/T2/T3 adds non-trivial complexity for unclear benefit**

The idle timeout mechanism (`cursor-client.ts:98-110`) already implements the core T1 concept -- waiting for new data after stream start. The T1=500ms check before sending check is a second timer doing similar work. T2=2s and T3=5s for subsequent retries are arbitrary values that will need extensive tuning against real traffic patterns.

**Challenge 2 — MEDIUM: "500ms of no new events" does not distinguish normal completion from truncation**

After the last SSE event arrives (stream done), 500ms of silence is indistinguishable from a normal short response followed by stream completion. The idea's own logic ("short reply <50 tokens skip T1") acknowledges this ambiguity -- but the threshold is arbitrary and will cause false negatives for legitimate short-but-incomplete responses.

**Challenge 3 — LOW: Short reply skip logic conflicts with the goal**

The <50 token skip means genuinely truncated short responses are never recovered. If the problem being solved is "premature stream termination," skipping short responses defeats the purpose of the mechanism.

**Severity: MEDIUM**

---

### IDEA-5: 短回复白名单 + 最小语义密度阈值

**Challenge 1 — MEDIUM: Dynamic whitelist maintenance is operationally complex**

The idea requires tracking prompt patterns and their normal response length distributions. This means maintaining state across requests, handling pattern drift, and dealing with cold-start (new prompt types with no history). For a proxy server handling diverse requests, this is a significant operational burden.

**Challenge 2 — MEDIUM: Semantic density threshold (0.5) is arbitrary**

The "valid token / total token" ratio requires defining what counts as a "valid token" -- a non-trivial linguistic computation. The 0.5 threshold is pulled from thin air with no empirical backing.

**Challenge 3 — MEDIUM: OR relationship between whitelist and density creates gaps**

If either condition permits passage, a malicious or buggy prompt with very short but valid response will pass through. The conditions should be AND, not OR, if the goal is strict prevention of false negatives.

**Severity: MEDIUM**

---

### IDEA-6: 去重缓冲队列 (Dedup Buffer Queue)

**Challenge 1 — MEDIUM: n-gram similarity is overkill for the problem**

The problem is "multiple check responses produce duplicate content." The simpler solution is to simply not send multiple check responses -- enforce a single check attempt. The existing `MAX_REFUSAL_RETRIES` already caps retry count at 2. A dedup buffer on top of retry counting adds complexity that could be avoided by stricter retry policy.

**Challenge 2 — MEDIUM: Token-sequence editing distance is expensive**

Computing edit distance or n-gram overlap for every incoming recovery fragment requires keeping full content in memory and running O(n) comparison on each chunk. For high-throughput scenarios, this adds measurable latency.

**Challenge 3 — LOW: Threshold of 0.7 overlap is unvalidated**

No justification for 0.7. Two legitimately different recovery responses could easily share more than 70% n-gram overlap (e.g., both starting with "Here is the code:").

**Severity: MEDIUM**

---

### IDEA-7: 分层恢复 vs 重试——独立状态机设计

**Challenge 1 — MEDIUM: State machine partially duplicates existing design**

The existing codebase already has functional separation: `sendCursorRequest` retry loop handles transport errors (fetch exceptions, non-200 responses). The handler-level retry mechanisms (refusal, short response, thinking fragment) handle content-layer failures. The `continuationCount` and `retryCount` are already independent counters. The state machine as described is largely what already exists, just formalized.

**Challenge 2 — MEDIUM: "两层状态独立、互不感知" may not hold**

If Recovery layer marks a stream as `FAILED`, should Retry layer still attempt? The idea says they are independent -- but in practice, a stream that produces truncated content repeatedly is unlikely to succeed on immediate retry regardless of transport layer. The independence assumption may lead to wasted retry budget.

**Challenge 3 — LOW: `FAILED` → `on_retry_exhausted` signal isolation is good design**

The signal isolation concept is sound and worth keeping. But this is an incremental refinement to existing retry logic, not a new architectural pattern.

**Severity: MEDIUM**

---

### IDEA-8: 统一抽象层 + Handler 特化实现

**Challenge 1 — MEDIUM: Over-engineering for 2 implementations**

The interface abstraction (`StreamRecoveryHandler`) is reasonable in principle, but currently there are exactly two handlers (Anthropic/OpenAI). Introducing a formal TypeScript interface with three methods and a coordinator class adds indirection for a pattern that could be handled with shared utility functions and handler-specific configuration objects. YAGNI applies here.

**Challenge 2 — MEDIUM: `onRecoveryResponse` deduplication is handler-specific**

The `onRecoveryResponse(fragment, buffer)` method tries to do SSE fragment processing and deduplication in the handler. But SSE event emission and response buffering are already handled by the existing streamer infrastructure. Moving deduplication into the handler creates a second processing pipeline that may conflict with the existing one.

**Challenge 3 — LOW: Interface segregation is good practice**

The principle of separating `detectIncomplete`, `buildRecoveryMessage`, and `deduplicate` is sound. If more handlers are added in the future, this pays off. But for current scope (2 handlers), a simpler shared module with configuration may suffice.

**Severity: MEDIUM**

---

## Summary Table

| Idea | Title | Severity | Primary Challenge | Recommendation |
|------|-------|----------|-------------------|----------------|
| IDEA-1 | 语义锚点检测法 | **CRITICAL** | False positives on normal completions; reinvents existing `isTruncated()` | DISCARD — existing detection already covers the real signals |
| IDEA-2 | 双层检测策略 | **MEDIUM** | Layer 1 duplicates `isTruncated()`; DeepCheck is unreliable | REVISE — merge with existing detector, use only where existing gaps exist |
| IDEA-3 | check/continue 语义分层 | **HIGH** | No evidence Cursor differentiates these; "check" already exists with Proxy hint | REVISE — align with existing `probe`/`continuation` distinction instead of inventing new semantics |
| IDEA-4 | 渐进式恢复时机 | **MEDIUM** | T1/T2/T3 are arbitrary timers duplicating idle timeout; short-reply skip creates false negatives | REVISE — integrate with existing idle timeout, remove skip logic |
| IDEA-5 | 短回复白名单 + 语义密度 | **MEDIUM** | Dynamic whitelist maintenance is complex; density threshold is arbitrary | REVISE — replace with simpler fixed threshold based on `stop_reason` |
| IDEA-6 | 去重缓冲队列 | **MEDIUM** | n-gram dedup is expensive; simpler solution is single-retry policy | REVISE — replace with strict single-check policy |
| IDEA-7 | 分层恢复状态机 | **MEDIUM** | Partially reinvents existing retry architecture; independence assumption may waste retry budget | PROCEED — formalize the separation with modifications |
| IDEA-8 | 统一抽象层 | **MEDIUM** | YAGNI for 2 handlers; interface may conflict with existing SSE pipeline | REVISE — use shared utilities instead of formal interface |

---

## Key Findings

### 1. The Core Premise Has a Blind Spot

All 8 ideas assume the problem is detecting missing completion semantics. But the existing `truncation-detector.ts` and the `stop_reason === 'max_tokens'` signal already cover the primary truncation case. The remaining gap is: **what happens when the stream ends normally (`stop_reason !== 'max_tokens'`) but the content feels premature?**

This is a fundamentally harder problem. Without an upstream signal, any detection heuristic is guessing. The ideas collectively underestimate this.

### 2. "check" and "continue" are not Magic Spells

The ideas treat "check" and "continue" as if they have special upstream semantics. In reality:
- "check" is already used in the codebase as a user message prefix with a `[Proxy: ...]` instruction
- "continue" already exists as the continuation mechanism
- The distinction between recovery approaches is already implemented in the retry strategy selection

The ideas should not propose new message formats. They should propose refinements to the existing strategy selection logic.

### 3. False Positive Rate is the Central Risk

Every detection idea risks misclassifying normal short responses as truncated. The most dangerous ideas (IDEA-1) are also the most confident in their accuracy. The 90% figure cited in IDEA-1 is unsubstantiated and likely optimistic.

### 4. The Real Implementation Path

Instead of 8 new mechanisms, the practical path is:
1. Extend existing `truncation-detector.ts` with `stop_reason` integration (already there)
2. Add a single "check probe" trigger for `stop_reason === 'end_turn'` but content suspiciously short (using existing `buildShortResponseRetryRequest`)
3. Add a single retry for this case, with deduplication handled by the existing retry counter
4. Formalize the Recovery vs Retry layer separation as described in IDEA-7

---

## GC Signal

**REVISION_NEEDED**

The ideas reveal good intent but collectively overestimate their novelty relative to existing code and underestimate the false-positive risk of semantic detection. IDEA-1 is fundamentally flawed (CRITICAL). Most ideas should be revised to build on existing infrastructure rather than propose parallel systems.

Priority for revision:
1. **IDEA-1** must be discarded or completely re-scoped
2. **IDEA-3** needs empirical verification of the check/continue distinction before proceeding
3. **IDEA-7** should be the primary vehicle -- formalizing the existing separation is the most actionable next step
