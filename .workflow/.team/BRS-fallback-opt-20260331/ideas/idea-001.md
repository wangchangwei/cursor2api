# Idea-001: 流式截断预防与可观测性

## Topic
cursor2api 防截断与 fallback 工具调用机制 — 最优设计方案

## Angles
从「流式阶段主动干预」和「可观测性」角度生成新想法

## Mode
Initial Generation

---

## Ideas

### Idea 1: 流式截断预测器 (Streaming Truncation Predictor)

**Description**: 在 SSE 流式阶段实时分析 token 消耗和响应模式，在截断真正发生前主动触发续写。相比现有的「等截断发生后再检测」模式，这是在上游主动干预。

**Key Assumption**: Claude API 的 token 消耗是可预估的，可以通过 `max_tokens` 和已消耗字符数推算剩余空间。

**Potential Impact**: 将 fallback 从「事后补救」变为「事前预防」，大幅减少因截断导致的无效请求。

**Implementation Hint**:
```typescript
// 在 executeStream 的每个 delta 回调中累积分析
let charCount = 0;
let toolBlockStarted = false;
let lastSignificantChunk = Date.now();

function analyzeStreamDelta(delta: string): TruncationRisk {
  charCount += delta.length;
  const estimatedTokensUsed = estimateTokens(charCount);
  const budgetRemaining = (body.max_tokens || 4096) - estimatedTokensUsed;

  // 风险信号：已消耗大量 token 但工具块尚未开启
  if (budgetRemaining < 200 && !toolBlockStarted) return 'HIGH';
  if (budgetRemaining < 500 && !toolBlockStarted) return 'MEDIUM';

  // 风险信号：长时间没有新内容（可能已卡住）
  if (Date.now() - lastSignificantChunk > 5000) return 'MEDIUM';

  return 'LOW';
}
```

当风险等级为 HIGH 时，立即发送一个空 tool_use 块让 Claude Code 保持工具循环，同时启动续写请求。这比等截断发生后 fallback 更优雅。

---

### Idea 2: 自适应 token budget 分配器

**Description**: 当前的 `max_tokens` 是固定值或用户指定值。当模型在工具模式下输出长 thinking 但工具调用尚未生成时，容易触发截断。自适应分配器根据对话上下文（是否有长时间 thinking、是否在执行复杂任务）动态调整 token 预算。

**Key Assumption**: 工具调用所需参数长度与任务复杂度正相关，复杂任务的 thinking 部分会更长，需要更多 token 预算。

**Potential Impact**: 减少「因为预算不够导致工具调用被截断」的概率，提升整体成功率。

**Implementation Hint**:
```typescript
function adaptTokenBudget(body: AnthropicRequest): AnthropicRequest {
  const hasLongHistory = body.messages.length > 10;
  const lastUserMsg = body.messages[body.messages.length - 1]?.content?.toString() || '';
  const isComplexTask = lastUserMsg.length > 500 || /\b(analyze|implement|refactor|build)\b/i.test(lastUserMsg);

  let budget = body.max_tokens || 4096;
  if (hasLongHistory) budget = Math.min(budget + 1024, 8192); // 历史长则增加预算
  if (isComplexTask) budget = Math.min(budget + 2048, 8192);   // 复杂任务增加更多

  return { ...body, max_tokens: budget };
}
```

结合流式截断预测器（Idea 1），在检测到高风险时动态提高预算，而不是等截断后 fallback。

---

### Idea 3: 可观测性埋点与回归检测

**Description**: 目前所有 fallback/重试行为都是静默的，没有指标监控。添加结构化日志和指标收集，能够追踪 fallback 使用率、重试成功率、截断模式等，在代码变更后自动检测到指标劣化（回归）。

**Key Assumption**: 现有代码中的 log.warn/log.info 调用已经覆盖了关键事件，但缺少结构化提取和聚合。

**Potential Impact**: 能够在发布前发现新的截断问题，而不是等用户报告。长期看可以基于数据优化 fallback 策略。

**Implementation Hint**:
```typescript
// 新增指标收集模块
const metrics = {
  truncationCount: 0,
  retrySuccessCount: 0,
  retryFailCount: 0,
  fallbackCount: 0,
  thinkingFragmentRetries: 0,
  avgFragmentLength: 0,
};

function recordTruncation(fragment: string) {
  metrics.truncationCount++;
  metrics.avgFragmentLength = (metrics.avgFragmentLength * (metrics.truncationCount - 1) + fragment.length) / metrics.truncationCount;
}

// 在关键节点调用 recordTruncation() / recordRetry() 等
// 在 SSE message_stop 事件中汇总输出：
log.info('Metrics', 'summary', JSON.stringify(metrics));
```

也可以将指标发送到外部监控系统（Prometheus、DataDog）进行长期趋势分析。

---

### Idea 4: 连续失败熔断器 (Circuit Breaker)

**Description**: 当连续 N 次请求都因为截断 fallback 时，继续重试会浪费资源且用户体验差。熔断器在检测到「连续失败模式」后，快速失败并返回降级响应，而不是反复触发昂贵的重试。

**Key Assumption**: 连续截断 fallback 通常意味着底层问题（模型服务不稳定、prompt 问题、token 耗尽），继续重试收益递减。

**Potential Impact**: 减少无效的重试开销，同时更快给用户一个有意义的降级响应。

**Implementation Hint**:
```typescript
class FallbackCircuitBreaker {
  private consecutiveFailures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureTime = 0;

  recordFailure() {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= 3) {
      this.state = 'open'; // 熔断打开
    }
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  shouldAllowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.lastFailureTime > 30000) {
      this.state = 'half-open'; // 30秒后尝试恢复
    }
    return this.state !== 'open';
  }
}
```

---

### Idea 5: 统一 handler/openai-handler 截断检测逻辑（消除重复）

**Description**: 当前 `handler.ts` 和 `openai-handler.ts` 各维护一套相似但不一致的截断检测逻辑。最明显的不一致：handler.ts 在 P0 改动中加入了 `upstreamFinishReason === 'max_tokens'` 检测，但 openai-handler.ts 仍使用旧版字符串启发式（无 upstreamFinishReason）。应该提取一个共享的 `TruncationDetector` 模块。

**Key Assumption**: 截断检测逻辑的核心是相同的（判断 partial_tool、thinking_only 等），handler.ts 和 openai-handler.ts 的差异只是入口点不同。

**Potential Impact**: 消除两套代码的维护负担，确保 P0/P1 改动同时生效于两个处理器，防止意外的不一致回归。

**Implementation Hint**:
```typescript
// src/truncation-detector.ts
export interface TruncationDetection {
  type: 'partial_tool' | 'thinking_only' | 'empty' | 'valid';
  shouldRetry: boolean;
  retryStrategy: 'continuation' | 'probe' | 'synthesis' | 'none';
  fragment?: string;
}

export function detectTruncation(
  text: string,
  stopReason: string,
  hasTools: boolean,
  hasToolCalls: boolean
): TruncationDetection { /* 统一逻辑 */ }
```

两个 handler 在流结束后调用 `detectTruncation()`，获得一致的检测结果和重试策略。

---

### Idea 6: Prompt 级别的截断预防指令

**Description**: 从 prompt 工程的角度入手，在请求 body 的 system prompt 或 messages 中注入「防截断指令」，让模型自身意识到 token 预算紧张时优先输出工具调用而不是长 thinking。

**Key Assumption**: 模型能够遵循 system prompt 中的约束指令，在检测到自己即将进入长 thinking 阶段时，主动切换到工具调用格式。

**Potential Impact**: 无需在下游做检测和 fallback，在上游让模型自然地避免进入截断风险。

**Implementation Hint**:
```typescript
function injectTruncationPreventionInstructions(
  body: AnthropicRequest,
  estimatedRemainingBudget: number
): AnthropicRequest {
  const budgetKB = Math.round(estimatedRemainingBudget / 4); // rough char estimate

  const preventionInstruction = `
当你的回复中包含工具调用时，请确保工具调用块 (```json action) 完整闭合。
如果估计回复长度将超过 ${budgetKB} 字符，请立即输出 ```json action 块开头，
不要先输出长段落的思考内容。
`.trim();

  return {
    ...body,
    system: body.system
      ? `${body.system}\n\n[截断预防] ${preventionInstruction}`
      : preventionInstruction,
  };
}
```

在流式截断预测器（Idea 1）检测到 HIGH 风险时，对下一个请求注入此指令，引导模型直接输出工具调用。

---

## Summary

本组想法从 6 个不同角度切入，覆盖了：

1. **主动预防**（流式预测器、动态 token 预算）— 改变「被动等截断」为「主动干预」
2. **可观测性**（埋点指标、回归检测）— 让不可见的失败模式可见化
3. **稳定性**（熔断器）— 在连续失败时快速降级
4. **一致性**（统一检测模块）— 消除 handler.ts 和 openai-handler.ts 的重复逻辑
5. **上游引导**（Prompt 级防截断指令）— 从源头引导模型行为

与 brainstorm.md 中已有的 4 个方案（ResponseIntent 分类器、thinking_only 上下文重试、ResponseValidator 类、stopReason 信号优先）形成互补，共同构成完整的防截断体系。
