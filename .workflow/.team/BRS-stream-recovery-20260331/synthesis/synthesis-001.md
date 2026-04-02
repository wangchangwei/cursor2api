# Synthesis: 下游断流主动恢复机制

**Synthesizer**: synthesizer
**Session**: BRS-stream-recovery-20260331
**Date**: 2026-03-31
**Input**: 8 ideas (IDEA-1 through IDEA-8), 8 critiques, gc_signal=REVISION_NEEDED

---

## 1. Input Summary

### Ideas Generated (GC Round 0)
| ID | Title | Core Angle | Key Claim |
|----|-------|-----------|-----------|
| IDEA-1 | 语义锚点检测法 | 断流检测模式 | 锚点匹配准确率90% |
| IDEA-2 | 双层检测策略 | 断流检测模式 | QuickCheck+DeepCheck性能平衡 |
| IDEA-3 | check/continue 语义分层 | 恢复消息格式 | WATCHFUL vs AGGRESSIVE 策略 |
| IDEA-4 | 渐进式恢复时机 | 触发时机 | T1/T2/T3 超时分层 |
| IDEA-5 | 短回复白名单+语义密度 | 防误触 | 动态阈值 |
| IDEA-6 | 去重缓冲队列 | 副作用处理 | n-gram相似度去重 |
| IDEA-7 | 分层恢复状态机 | 与retry机制关系 | 独立状态机设计 |
| IDEA-8 | 统一抽象层 | Handler一致性 | 接口+特化实现 |

### Challenger Critique Summary
- CRITICAL x1: IDEA-1 误判率太高，正常回复没有done锚点，与现有isTruncated()重复
- HIGH x1: IDEA-3 无证据表明Cursor API区分check和continue
- MEDIUM x6: 其余ideas各有实现问题
- **真正未解决的gap**: stop_reason=end_turn 但内容感觉提前结束

### Existing Codebase (Ground Truth)
1. `truncation-detector.ts` — isTruncated()、looksLikeThinkingFragment()、detectTruncation()
2. `handler.ts` — buildShortResponseRetryRequest() 发送 "check" + Proxy hint
3. `shouldAutoContinueTruncatedToolResponse()` — 自动续写循环
4. 已有分层: transport retry (fetch异常)、content retry (refusal/short-response/thinking-fragment)
5. `stop_reason === 'max_tokens'` 是精确截断信号，已被使用

---

## 2. Extracted Themes

| Theme | Strength | Supporting Ideas | Challenger Verdict |
|-------|----------|-----------------|-------------------|
| **结构性截断检测已有覆盖** | 10/10 | IDEA-1部分, IDEA-2部分 | IDEA-1应丢弃，isTruncated已够 |
| **内容完整性感觉判断不可靠** | 9/10 | IDEA-1, IDEA-2, IDEA-5 | 语义锚点误判率高，动态白名单运维复杂 |
| **check/continue语义分化无上游证据** | 8/10 | IDEA-3 | HIGH challenge — check已存在且带Proxy hint，continue已作为continuation机制存在 |
| **渐进式时机与现有idle timeout重叠** | 7/10 | IDEA-4 | 500ms无事件与正常结束无法区分 |
| **单次check去重优于n-gram缓冲** | 8/10 | IDEA-6 | MEDIUM challenge — 严格retry计数即可解决 |
| **分层架构已有雏形** | 7/10 | IDEA-7 | PROCEED with modifications |
| **Handler特化抽象YAGNI** | 6/10 | IDEA-8 | MEDIUM challenge — 2个handler无需正式接口 |

**Key Insight**: 所有ideas的核心盲点是把"正常结构但内容感觉短"当成检测问题，实际上这是需要probe补救的问题，而非检测问题。

---

## 3. Conflict Resolution

### Conflict 1: 检测 vs 补救
- **IDEA-1/2**: 投入大量精力做语义检测来识别截断
- **Challenger**: 语义检测误判率太高，正常回复没有锚点
- **Resolution**: 放弃语义检测思路，改为"结构性通过但内容感觉短"时直接probe补救

### Conflict 2: check vs continue 的协议语义
- **IDEA-3**: 认为Cursor API对check和continue有差异化响应
- **Challenger**: 无证据证明，check已存在于代码中带Proxy hint
- **Resolution**: 废弃check/continue的协议区分，统一使用现有buildShortResponseRetryRequest的probe机制

### Conflict 3: 渐进式时机 vs 立即检测
- **IDEA-4**: T1/T2/T3渐进式等待
- **Challenger**: 500ms沉默无法区分正常结束和断流
- **Resolution**: 不在时机上做文章，在内容特征上做判断

### Conflict 4: 动态白名单 vs 固定规则
- **IDEA-5**: 动态维护prompt pattern历史
- **Challenger**: 运维复杂，冷启动和pattern drift问题
- **Resolution**: 用stop_reason + 固定长度阈值替代动态白名单

### Conflict 5: n-gram去重 vs 单次重试
- **IDEA-6**: 复杂去重缓冲队列
- **Challenger**: O(n)计算开销，简单单次check策略即可
- **Resolution**: 单次probe retry，不做增量拼接，重复直接丢弃

---

## 4. Integrated Proposals

### Proposal A: 扩展 truncation-detector.ts — 覆盖 end_turn + 感觉短场景

**Core Concept**: 在现有 `detectTruncation()` 的4种case之外，新增第5种case：响应结构完整(`isTruncated()=false`)但 stop_reason=end_turn 且内容极短。调用方收到 `shouldRetry: true, strategy: 'probe'` 时执行一次probe重试。

**Source Ideas**: IDEA-3(revised), IDEA-5(simplified)

**Addressed Challenges**:
- IDEA-1 CRITICAL: 不使用语义锚点，只用 stop_reason + 固定长度阈值，无误判风险
- IDEA-3 HIGH: 不发明新的check/continue协议区分，复用现有 probe 机制
- IDEA-5 MEDIUM: 不用动态白名单，用固定阈值（响应字数 < 请求复杂度的某个比例时触发）

**Implementation Direction** (in `truncation-detector.ts`):
```typescript
// 新增 case 5: end_turn + 结构完整但内容可疑
export function detectTruncation(
    text: string,
    stopReason: string,
    hasTools: boolean,
    requestContext?: { promptTokens?: number; toolCount?: number },
): TruncationDetection {
    // ... 现有 case 1-4 不变 ...

    // Case 5: end_turn 但响应极短 (无工具模式)
    if (!hasTools && stopReason !== 'max_tokens') {
        const trimmed = text.trim();
        // 固定阈值: 响应 < 50 chars 且非纯数字（纯数字如"25"是有效响应）
        if (trimmed.length > 0 && trimmed.length < 50 && !trimmed.match(/^\d+(\.\d+)?$/)) {
            return {
                type: 'end_turn_short',
                trimmed,
                upstreamMaxTokens: false,
                shouldRetry: true,
                strategy: 'probe',
            };
        }
    }

    // Case 6: end_turn + 结构完整但相对请求规模异常短 (工具模式)
    // 仅当 isTruncated()=false 且 hasToolCalls()=false 时考虑
    if (hasTools && stopReason !== 'max_tokens' && !isTruncated(text) && !hasToolCalls(text)) {
        const trimmed = text.trim();
        // 阈值: 响应 < 20 chars 且不是纯数字
        if (trimmed.length > 0 && trimmed.length < 20 && !trimmed.match(/^\d+/)) {
            return {
                type: 'end_turn_short',
                trimmed,
                upstreamMaxTokens: false,
                shouldRetry: true,
                strategy: 'probe',
            };
        }
    }

    return { /* valid */ };
}
```

**Feasibility**: 9/10 — 利用现有 probe 机制，只需扩展 detectTruncation 逻辑
**Innovation**: 5/10 — 是现有机制的延伸，非全新想法

**Benefits**:
- 零误判风险: 触发条件是 stop_reason=end_turn + 内容 < 50 chars，非数字，无结构性截断
- 与现有probe机制完全兼容
- 调用方改动最小: 只需在收到 `strategy === 'probe'` 时执行重试

**Remaining Risks**:
- 极短正常回复（如 "Sure."）会被probe，但这是一次额外请求，副作用有限
- 阈值(50/20 chars)需要生产流量验证

---

### Proposal B: Formalize 分层状态机 — 与现有 retry 架构对齐

**Core Concept**: 在代码注释和变量命名层面明确两层分离: **Transport Layer** (网络错误、非200) 和 **Content Layer** (refusal/short-response/thinking-fragment/now: end_turn_short)。在 `truncation-detector.ts` 中正式定义 content recovery 的状态机，不新增状态存储，只用现有 `retryCount` 和 `continuationCount` 追踪。

**Source Ideas**: IDEA-7 (modified)

**Addressed Challenges**:
- IDEA-7 MEDIUM: 独立状态机部分重复现有设计 — 修改为"形式化注释+变量组织"而非新状态存储
- IDEA-7 MEDIUM: "两层互不感知可能浪费retry预算" — 改为共享retry计数池

**Implementation Direction**:

```typescript
// ====== Transport Layer (Existing) ======
// sendCursorRequest() 循环: fetch异常 → retryCount < MAX_REFUSAL_RETRIES → 重试
// 触发条件: 网络错误, 非200状态码

// ====== Content Recovery Layer (Formalize) ======
// 在 truncation-detector.ts 中:
export type ContentRecoveryStrategy =
    | 'probe'         // 极短响应: buildShortResponseRetryRequest + 重试
    | 'continuation'  // 思考片段: 注入上下文重试
    | 'fallback'      // 不可恢复: 合成fallback tool call
    | 'end_turn_short'; // end_turn + 感觉短: probe重试

// 单一重试预算: retryCount (共享池)
// - refusal重试: +1
// - short probe: +1
// - thinking continuation: +1
// - end_turn_short probe: +1 (Proposal A新增)
// 总预算: retryCount < MAX_REFUSAL_RETRIES (默认2)
```

**Feasibility**: 9/10 — 主要是整理和注释工作
**Innovation**: 3/10 — 形式化现有设计

**Benefits**:
- 架构清晰: Transport retry vs Content recovery 分离在代码注释中明确
- 调试友好: 日志标签区分 `retry`(transport) 和 `probe`(content)
- 共享预算: 避免 content 失败消耗 transport 的重试机会

**Remaining Risks**:
- 如果 end_turn_short probe 失败后，transport 层可能仍会重试 — 这是预期行为（断流有时是瞬时的）

---

### Proposal C: 无新增机制 — 利用现有 probe 机制覆盖 end_turn_short

**Core Concept**: 不修改 `truncation-detector.ts`，不新增状态机。只需在 handler.ts 和 openai-handler.ts 中各加一处检查: 当 `upstreamFinishReason='end_turn'` 且响应极短时，调用 `buildShortResponseRetryRequest()` 重试一次。这是 Proposal A 的最小化替代版本。

**Source Ideas**: IDEA-3(revised)

**Addressed Challenges**:
- IDEA-3 HIGH: 不发明check/continue协议区分，复用现有probe
- 所有ideas的过度设计问题

**Implementation Direction**:

```typescript
// handler.ts, 工具模式主循环末尾 (在 stopReason = 'end_turn' 判定之后):
// ★ 新增: end_turn 但响应极短时的probe重试
if (stopReason === 'end_turn' && hasTools && !hasToolCalls(fullResponse)) {
    const t = fullResponse.trim();
    // 阈值: < 20 chars 且非纯数字
    if (t.length > 0 && t.length < 20 && !t.match(/^\d+(\.\d+)?$/) && retryCount < MAX_REFUSAL_RETRIES) {
        retryCount++;
        log.warn('Handler', 'probe', `end_turn + 响应极短 (${t.length} chars)，probe重试第${retryCount}次`);
        activeCursorReq = await convertToCursorRequest(buildShortResponseRetryRequest(body, fullResponse));
        resetHybridForRetry();
        await executeStream(true, processHybridDelta);
        flushHybridStreamEnd();
        hybridAlreadySentText = hybridAlreadySentText || hybridTextSent;
    }
}
```

类似逻辑也适用于 openai-handler.ts 的非流式和流式处理路径。

**Feasibility**: 10/10 — 最少改动，只加一段if判断
**Innovation**: 2/10 — 是现有机制的直接延伸

**Benefits**:
- 改动极小，风险极低
- 与现有probe逻辑完全一致
- 复用已有去重机制(retryCount)

**Remaining Risks**:
- 阈值(20 chars)可能需要调优
- 在openai-handler和handler两侧都要加，保持一致性

---

## 5. Coverage Analysis

| 原始维度 | 覆盖情况 | 说明 |
|---------|---------|------|
| 断流检测模式 | Proposal A/C | 用stop_reason+长度阈值，不用语义锚点 |
| 恢复消息格式 | 不需新设计 | 复用现有probe，无新check/continue区别 |
| 触发时机 | 无新时机设计 | 不做渐进式等待，内容可疑就probe |
| 防误触 | Proposal A/C | 固定阈值(20-50 chars)+stop_reason+非数字，三重保障 |
| 副作用处理 | 复用现有机制 | 不做n-gram去重，复用retryCount |
| 与retry关系 | Proposal B | 明确分层，共享预算池 |
| Handler一致性 | 无需新抽象 | 两处各加一段if，无需接口 |

**未覆盖但接受的风险**:
- 正常短回复(如 "Sure.") 会被probe一次 — 可接受，一次额外请求
- 响应30-49 chars的end_turn场景 — 当前未覆盖，可作为后续调参方向

**核心结论**: 最小可行方案是 Proposal C（零新增机制，只加几行if）。如果愿意稍微多投入一点，Proposal A（扩展detectTruncation返回值）在长期可维护性上更好。Proposal B 只需要注释整理，不涉及代码逻辑变更。

---

## 6. Recommended Next Steps

1. **立即可做**: 在 handler.ts 和 openai-handler.ts 中各加一处 `end_turn + 极短响应 → probe重试` (Proposal C)
2. **短期**: 将此逻辑正式纳入 `truncation-detector.ts` 作为 Case 5 (Proposal A)，统一检测入口
3. **中期**: 添加注释和日志标签，明确 Transport vs Content 分层 (Proposal B)
4. **验证**: 生产流量观察 probe 重试率，收集误触发案例，调优长度阈值
