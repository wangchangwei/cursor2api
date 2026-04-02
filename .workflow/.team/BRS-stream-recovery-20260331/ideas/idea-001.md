# Ideas: 下游断流主动恢复机制

## Topic
下游断流主动恢复机制：监控响应末尾缺失完成语义，主动发送 check/continue 补救

## Angles
1. 断流检测模式（语义判断 vs 字符判断 vs SSE 事件判断）
2. 恢复消息的格式（check vs continue 的语义差异）
3. 触发时机（每个流结束后都检测 vs 静默超时后触发）
4. 防误触（避免正常短回复被误判）
5. 副作用处理（多次 check 导致重复内容怎么办）
6. 与现有 retry 机制的关系（是独立的还是叠加的）
7. OpenAI handler 和 Anthropic handler 的一致性

## Mode
Initial Generation (GC Round 0)

---

## Ideas

### IDEA-1: 语义锚点检测法（Semantic Anchor Detection）

**Angle**: 断流检测模式

**Description**:
在流结束后对最后一块内容进行语义分析，检测是否包含完成锚点（completion anchors）。完成锚点包括显式词汇（"done"、"complete"、"finished"）、隐式结构（完整的代码块闭合 `` ``` ``、完整的 JSON 闭合 `}`）以及特定的结束标点模式（句号+换行 in 回答类内容）。

**Key Assumption**:
Claude API 的完整响应总会以明确的语义边界结束，短回复（如单行确认）也有自然结束标志。

**Potential Impact**:
检测准确性高，误报率低。可覆盖 90% 以上的正常完成场景。

**Implementation Hint**:
定义 `CompletionAnchors` 集合，包含正向锚点（存在则安全）和负向锚点（缺失则可疑）。流结束后取最后 N tokens 进行匹配打分，总分低于阈值则触发恢复。

---

### IDEA-2: 双层检测策略（Two-Layer Detection）

**Angle**: 断流检测模式

**Description**:
结合字符级和语义级双重检测。Layer 1 用轻量级规则快速扫描（是否以句号/问号/感叹号结尾、代码块是否闭合）；Layer 2 用语义分析器判定内容是否处于"未完成状态"（如正在列举项目但未达数量、正在解释但缺少结论）。Layer 1 通过后放行；Layer 1 失败或 Layer 2 可疑时才触发恢复。

**Key Assumption**:
大多数正常回复在字符级就能通过检测，语义分析只在边界情况触发，开销可控。

**Potential Impact**:
平衡了检测精度与性能开销，避免每次流结束都做昂贵的语义分析。

**Implementation Hint**:
定义 `QuickCheck` 规则集（正则+状态机）和 `DeepCheck` 规则集（LLM 分类或规则匹配）。快速检查通过率目标 >80%，快速失败才走深度检查。

---

### IDEA-3: check 与 continue 语义分层设计

**Angle**: 恢复消息的格式

**Description**:
将 check 和 continue 理解为两种不同的恢复语义而非两个名字。**check** 用于验证当前上下文是否完整——发送一个无副作用的轻量探测（如 "continue" 单token），期望收到剩余内容的补全；**continue** 用于主动推动流继续——发送带有显式指令的消息（如 "please continue"），期望收到因中断而未发送的剩余内容。两种消息的触发条件不同：check 用于可疑但不确定的场景，continue 用于高度确信断流的场景。

**Key Assumption**:
Cursor 上游对 check/continue 的语义有差异化响应逻辑。

**Potential Impact**:
避免"过度恢复"——不确定时不发强指令，只发探测。

**Implementation Hint**:
定义恢复策略枚举：`WATCHFUL`（check）和 `AGGRESSIVE`（continue）。根据检测置信度选择策略。check 消息内容可为空或极简；continue 消息统一为 "continue" 或 "please continue"。

---

### IDEA-4: 渐进式恢复时机（Progressive Recovery Timing）

**Angle**: 触发时机

**Description**:
不采用"立即检测立即恢复"的激进策略，而是采用渐进式时机：流结束后 T1（默认 500ms）内若无新事件，发送 check；若 T2（默认 2s）后仍未恢复，发送 continue；若 T3（默认 5s）后仍无响应，标记为不可恢复并上报。短回复（< 50 tokens）跳过 T1 检查直接放行。

**Key Assumption**:
正常流结束和断流的区别在于：断流后没有后续事件，正常完成后没有新的待处理事件。

**Potential Impact**:
大幅减少误触发，同时保证在真实断流场景下的恢复速度。

**Implementation Hint**:
使用定时器管理各层超时。每个流结束时启动 T1 计时器，超时无新事件则触发 check；T2/T3 用于后续恢复尝试。记录每次恢复尝试的耗时用于调参。

---

### IDEA-5: 短回复白名单 + 最小语义密度阈值

**Angle**: 防误触

**Description**:
定义两类放行条件：1) **短回复白名单**：当回复总 token 数 < 某个阈值（如 30 tokens）且以常见结束符结尾时，直接判定为正常完成；2) **最小语义密度**：计算回复中有效语义 token 的比例（如去除空白、重复填充词），低于阈值（如 0.5）时判定为可疑，触发恢复。白名单基于历史数据动态调整——如果某类 prompt 的正常回复普遍较短，则降低对应阈值。

**Key Assumption**:
正常短回复的特征可以通过历史数据统计得到。

**Potential Impact**:
有效消除"用户发一个 'hi'，系统误以为断流"的误判。

**Implementation Hint**:
配置 `ShortReplyWhitelist`：记录每个 prompt pattern 的正常回复长度分布。实现 `SemanticDensityCalculator`：统计有效 token / 总 token 比例。两个条件都是 OR 关系——任一条件满足即可放行。

---

### IDEA-6: 去重缓冲队列（Dedup Buffer Queue）

**Angle**: 副作用处理

**Description**:
维护一个流级别的去重缓冲：每次收到恢复响应时，先将内容与缓冲中的已有内容做相似度比对（基于 token 序列的编辑距离或 n-gram 重叠度），超过相似度阈值的内容标记为重复并丢弃。同时，缓冲队列在流完成确认或超时后清空。多次恢复响应的内容按顺序拼接，而非替换。

**Key Assumption**:
重复内容与新内容的语义重叠度高，可以通过简单的重叠度检测识别。

**Potential Impact**:
避免多次 check 导致的重复 token 污染下游，同时保留真正的增量内容。

**Implementation Hint**:
定义 `DedupBuffer`：每个流一个 buffer，key 为 stream_id。`similarity(a, b)` 函数使用 sliding window n-gram 重叠度计算。阈值（如 0.7）可配置。重复内容记录到 debug log 但不发送给下游。

---

### IDEA-7: 分层恢复 vs 重试——独立状态机设计

**Angle**: 与现有 retry 机制的关系

**Description**:
将断流恢复机制设计为与现有 retry 完全独立的分层状态机。**Retry 层**负责网络错误、超时等传输层失败，触发条件是 `fetch()` 抛出异常或返回非 200 状态码。**Recovery 层**负责内容层断流，触发条件是流正常结束但内容不完整。两层状态独立、互不感知，各自有独立的重试计数和退避策略。Recovery 层最多尝试 N 次（建议 2 次），超过后放弃并标记错误。

**Key Assumption**:
断流和传输失败有本质区别，混淆两层会导致修复策略不当（如传输失败时不应该发 check）。

**Potential Impact**:
架构清晰，调试简单。retry 和 recovery 可以独立开关、独立配置、独立监控。

**Implementation Hint**:
定义 `StreamRecoveryStateMachine`：状态包括 `ACTIVE`, `CHECKING`, `CONTINUING`, `RESOLVED`, `FAILED`。事件驱动：`stream_end` → `CHECKING` → `stream_resume` → `RESOLVED`；`stream_end` → `CHECKING` → 超时 → `CONTINUING` → 超时 → `FAILED`。与 Retry 层通过 `on_retry_exhausted` 信号隔离。

---

### IDEA-8: 统一抽象层 + Handler 特化实现

**Angle**: OpenAI handler 和 Anthropic handler 的一致性

**Description**:
定义统一的 `StreamRecoveryHandler` 接口，包含三个核心方法：`detectIncomplete(stream_content) -> bool`、`buildRecoveryMessage(type: CHECK | CONTINUE) -> string`、`deduplicate(incoming, existing) -> string`。OpenAI Handler 和 Anthropic Handler 分别实现该接口，差异化体现在：消息格式（如 Anthropic 支持 `extra_headers` 传递元数据，OpenAI 支持 `stream_options`）、检测锚点（如 Anthropic 的 `stop_reason` 字段 vs OpenAI 的 `finish_reason`）、超时配置。接口层统一处理去重、超时、退避逻辑。

**Key Assumption**:
两种 Handler 的差异仅在消息格式和特定字段名，业务逻辑（检测、恢复、去重）可以完全共享。

**Potential Impact**:
新增加一条消息协议时只需实现接口，无需重复写恢复逻辑。

**Implementation Hint**:
```typescript
interface StreamRecoveryHandler {
  detectIncomplete(content: string, metadata: StreamMetadata): IncompleteResult;
  buildRecoveryMessage(type: 'CHECK' | 'CONTINUE'): string;
  onRecoveryResponse(fragment: string, buffer: string[]): ProcessedFragment;
}
class AnthropicStreamRecoveryHandler implements StreamRecoveryHandler { /* ... */ }
class OpenAIStreamRecoveryHandler implements StreamRecoveryHandler { /* ... */ }
class StreamRecoveryCoordinator {
  private handler: StreamRecoveryHandler;
  // 通用超时、去重、退避逻辑
}
```

---

## Summary

生成了 8 个ideas，覆盖了断流恢复机制的 7 个核心维度：

| # | Idea | 核心贡献 | 关键词 |
|---|------|----------|--------|
| 1 | 语义锚点检测法 | 精准的完成语义识别 | 正向/负向锚点 |
| 2 | 双层检测策略 | 性能与精度的平衡 | QuickCheck + DeepCheck |
| 3 | check/continue 语义分层 | 差异化恢复策略 | WATCHFUL vs AGGRESSIVE |
| 4 | 渐进式恢复时机 | 减少误触的时间策略 | T1/T2/T3 超时分层 |
| 5 | 短回复白名单 + 语义密度 | 防误触双保险 | 阈值 + 密度 |
| 6 | 去重缓冲队列 | 消除重复副作用 | n-gram 相似度 |
| 7 | 分层恢复状态机 | 与 retry 机制隔离 | 状态机独立 |
| 8 | 统一抽象层 | Handler 一致性 | 接口 + 特化实现 |
