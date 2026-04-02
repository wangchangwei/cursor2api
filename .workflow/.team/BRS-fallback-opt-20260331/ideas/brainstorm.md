# cursor2api fallback 机制最优解

## 当前问题根因

1. **信号不可靠** — `< 200 chars + 标点结尾` 只是表象，误判正常短回复
2. **fallback 质量为零** — 合成的工具调用参数全是空占位符，下游无法执行
3. **逻辑重复** — handler.ts 和 openai-handler.ts 各自维护一套相似规则
4. **无状态** — 每次独立判断，感知不到「连续失败」模式

---

## 方案一：响应意图分类器 ★★★★★

**核心**：用分类函数代替零散启发式条件，统一判断响应类型。

```typescript
type ResponseIntent =
  | 'tool_call'      // 包含完整工具调用
  | 'partial_tool'   // 工具调用被截断
  | 'thinking_only'  // 只有思考片段
  | 'refusal'        // 模型拒绝
  | 'valid_text'     // 正常文本响应
  | 'empty';         // 空/无效

function classifyResponse(text: string, hasTools: boolean): ResponseIntent
```

分类优先级：
1. `hasToolCalls(text)` → `tool_call`
2. `isTruncated(text)` 且有 json action 开标签 → `partial_tool`
3. `isRefusal(text)` → `refusal`
4. `text.length < 10` → `empty`
5. `hasTools && text.length < 200 && /[：:,，。.…]$/.test(text)` → `thinking_only`（**这里是现有逻辑的收口**）
6. 其他 → `valid_text`

**动作映射**：
```
tool_call     → 正常返回
partial_tool  → shouldAutoContinue
refusal       → retryWithProbe
empty         → retryWithProbe  
thinking_only → retryWithBetterPrompt（见方案二）
valid_text    → 正常返回
```

**优势**：
- 所有判断逻辑集中一处，handler.ts 和 openai-handler.ts 共用
- 新增分类只改一个函数，不用到处打补丁
- 可测试：对每种 ResponseIntent 写单元测试

---

## 方案二：thinking_only 时注入上下文重试 ★★★★★

**当前问题**：`looksLikeThinkingFragment` 触发后直接 fallback 合成空参数工具调用，下游无法执行。

**最优解**：不合成空 fallback，而是带着「思考片段」重试，让模型完成它已经开始的工作。

```typescript
function buildThinkingFragmentRetryRequest(
  body: AnthropicRequest,
  thinkingFragment: string
): AnthropicRequest {
  // 把模型的思考片段作为 assistant 消息注入对话
  // 再加一条 user 消息："请继续完成工具调用"
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: 'assistant', content: thinkingFragment },
      { role: 'user', content: '请继续完成上述工具调用，直接输出 ```json action 块。' },
    ],
  };
}
```

**为什么比空 fallback 好**：
- 模型已经在思考「先找到...组件」，它知道要做什么，只是被截断了
- 带着这个上下文重试，模型大概率能补全正确的工具调用（带真实参数）
- 空 fallback 只是让下游收到一个无意义请求，用户体验更差

---

## 方案三：统一 ResponseValidator 类 ★★★★☆

**解决逻辑重复问题**：提取一个共享模块 `response-validator.ts`。

```typescript
// src/response-validator.ts
export interface ValidationResult {
  intent: ResponseIntent;
  shouldRetry: boolean;
  retryStrategy: 'probe' | 'continuation' | 'thinking-fragment' | 'none';
  retryRequestBuilder?: (body: AnthropicRequest, context: string) => AnthropicRequest;
}

export function validateResponse(
  text: string,
  hasTools: boolean,
  retryCount: number
): ValidationResult
```

handler.ts 和 openai-handler.ts 都 import 这个，消除重复逻辑。

---

## 方案四：stopReason 信号优先 ★★★★☆

**当前盲区**：Cursor SSE 流中 `message_stop` 事件包含 `stop_reason`（`end_turn` / `max_tokens` / `tool_use`），但现有代码只在日志里打印，没有用于 fallback 决策。

`stop_reason === 'max_tokens'` 是**最可靠的截断信号**，比字符串启发式精确得多。

```typescript
// 在流结束后
if (stopReason === 'max_tokens' && hasTools && !hasToolCalls(fullResponse)) {
  // 这才是真正的截断，触发续写
  // 而不是靠字符串匹配猜测
}

if (stopReason === 'end_turn' && fullResponse.length < 10) {
  // 模型正常结束但内容为空 → 很可能是 refusal 或上下文问题
  // 触发 probe 重试
}
```

**实现要点**：
- 在 SSE 解析阶段把 `stop_reason` 传递给后处理逻辑（现在只存在 `stopReason` 变量但未用于判断）
- `max_tokens` → 续写；`end_turn` + 空响应 → probe 重试；`tool_use` + 无工具调用 → thinking_only 重试

---

## 综合推荐：最优实施路径

优先级排序（投入产出比）：

| 优先级 | 方案 | 改动量 | 预期效果 |
|--------|------|--------|----------|
| P0 | 方案四：stopReason 信号 | 小（10行） | 截断检测精度大幅提升 |
| P1 | 方案二：thinking_only 带上下文重试 | 小（30行） | 消除空 fallback，下游真正可用 |
| P2 | 方案一：ResponseIntent 分类器 | 中（50行） | 逻辑统一，可测试，可扩展 |
| P3 | 方案三：共享 ResponseValidator | 中（重构） | 消除重复，长期维护成本降低 |

### P0 立即可做（最小改动，最大收益）

把 `stopReason` 接入 fallback 判断：

```typescript
// 现有代码（handler.ts ~1528）
const looksLikeThinkingFragment = hasTools && !hasToolCalls(fullResponse) 
  && t.length > 0 && t.length < 200 && /[：:,，。.…]$/.test(t);

// 替换为：
const looksLikeThinkingFragment = hasTools && !hasToolCalls(fullResponse)
  && (
    // 优先用 stopReason 信号（精确）
    stopReason === 'max_tokens'
    // 降级到启发式（兼容 stopReason 不可用的情况）
    || (t.length > 0 && t.length < 200 && /[：:,，。.…]$/.test(t))
  );
```

然后把 fallback 从「合成空工具调用」改为「带思考片段重试」：

```typescript
// 不再合成空 fallback，而是：
if (looksLikeThinkingFragment && retryCount < MAX_REFUSAL_RETRIES) {
  retryCount++;
  activeCursorReq = await convertToCursorRequest(
    buildThinkingFragmentRetryRequest(body, fullResponse)
  );
  fullResponse = '';
  continue; // 重试循环
}
// 只有重试耗尽才 fallback 合成空工具调用（保底）
```
