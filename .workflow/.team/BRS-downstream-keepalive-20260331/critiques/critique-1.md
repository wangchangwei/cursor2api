# Critique - Round 0

## Metadata

| Field | Value |
|---|---|
| Topic | 修复下游断开问题（响应过短/空内容导致下游断流） |
| Role | Challenger |
| GC Round | 0 |
| Date | 2026-03-31 |

## Ideas Reviewed

IDEA-1, IDEA-2, IDEA-3, IDEA-4, IDEA-5, IDEA-6, IDEA-7, IDEA-8

---

## Per-Idea Challenges

### IDEA-1: 请求前上游健康探测（Pre-stream Probe）

| Field | Value |
|---|---|
| Severity | **CRITICAL** |
| Challenge Type | Assumption Validity |

**Problem 1: 循环依赖 (Circular Dependency)**
- 探测假设"上游在探测时有内容返回能力"，但这正是我们要解决的问题
- 若上游正在断流，探测请求同样会断流，导致"探测成功但真实请求失败"
- 探测结果完全无法预测真实请求的命运

**Problem 2: 性能惩罚不可忽视**
- 每次请求增加 2-3 秒强制等待，即便在正常情况下也必然发生
- 对于 Cursor API 稳定场景，这是不必要的开销
- 用户体验：每个请求额外等待 2-3 秒，而 probe 成功/失败对后续无预测价值

**Problem 3: 探测可能加剧上游不稳定**
- Cursor API 若处于限流状态，额外的探测请求会消耗宝贵的请求配额
- 探测失败后真实请求仍会重试，形成 2x 请求浪费

**Verdict**: 核心假设循环论证，引入性能惩罚且无预测价值，CRITICAL 需重新设计。

---

### IDEA-2: 流式内容速度监控 + 提前中断重试

| Field | Value |
|---|---|
| Severity | **HIGH** |
| Challenge Type | Feasibility + Risk Assessment |

**Problem 1: 阈值拍脑袋，缺乏数据支撑**
- "5秒窗口内 < 50 bytes 判定异常" 是拍脑袋数字
- 正常 Cursor API 流式响应在首字节到达时间上差异极大（从 1s 到 10s+）
- 流式 API 的特性就是开始慢后面快，误触发概率高

**Problem 2: 触发重试的中途断流风险**
- 在流中间触发重试，会导致下游收到部分内容 + 重试后的新内容
- 如果不清理下游缓冲区，会产生重复/乱序内容
- `buildShortResponseRetryRequest` 的重试不清理 HTTP 连接状态，可能导致下游混淆

**Problem 3: 与现有退化检测（cursor-client.ts）重叠**
- cursor-client.ts 已有退化循环检测（REPEAT_THRESHOLD=8）、空闲超时（IDLE_TIMEOUT_MS）
- 速度监控与这些机制的关系不明确，可能产生竞态或重复干预

**Verdict**: 阈值设计需要生产数据支撑，HIGH 需精化阈值策略并明确与现有检测机制的协作边界。

---

### IDEA-3: 结构化合流响应（SSE Multiplexing）

| Field | Value |
|---|---|
| Severity | **MEDIUM** |
| Challenge Type | Assumption Validity |

**Problem 1: 下游兼容性假设未验证**
- "下游能解析并响应新增的 meta 帧类型" 是强假设
- 很多 SSE 客户端库默认忽略未知事件类型，但不会主动处理
- 如果下游忽略 meta 帧，这个 idea 毫无效果

**Problem 2: 协议设计不完整**
- `type`、`sequence`、`length_hint` 字段的语义和时序没有定义
- meta 帧与内容帧的顺序关系？内容帧是否还需要？
- 空响应时发送 meta 帧后，下游应等待还是断开？无明确契约

**Problem 3: 收益不确定**
- 即使下游能解析 meta 帧，它能做什么？它仍然依赖上游恢复
- 本质上是一个通知机制，不解决断流问题本身

**Verdict**: 依赖于下游配合且无明确契约，MEDIUM。建议作为 IDEA-7（语义化降级）的补充而非独立方案。

---

### IDEA-4: 短路熔断器（Circuit Breaker）

| Field | Value |
|---|---|
| Severity | **MEDIUM** |
| Challenge Type | Risk Assessment |

**Problem 1: 故障分类错误 - 瞬时故障 vs 持续故障**
- "短响应是 Cursor API 端问题而非偶发" 是错误假设
- Cursor API 的断流问题高度偶发（用户报告和网络状况影响）
- 熔断后直接降级 = 放弃可能成功的重试机会，比继续重试更差

**Problem 2: 熔断状态下的用户体验降级**
- 60 秒窗口 + 熔断触发 = 接下来 60 秒所有用户请求都降级
- 如果是瞬时故障，用户体验变成"所有请求都失败 60 秒"而非"部分请求失败"
- 这个设计把偶发问题放大为集体惩罚

**Problem 3: 阈值调优困难**
- "60 秒 / N 次" 的阈值在没有历史数据的情况下是盲猜
- 调优不当会产生"永远熔断"或"从不触发"的极端行为

**Verdict**: 假设与实际问题特征不符，MEDIUM。建议阈值改为动态/自适应，并加入试探性半开状态。

---

### IDEA-5: 连接上下文保持重试（Context-Preserving Retry）

| Field | Value |
|---|---|
| Severity | **HIGH** |
| Challenge Type | Assumption Validity + Risk Assessment |

**Problem 1: 截断内容包含错误上下文的危险**
- 核心假设："部分响应（即使很短）可能包含有效语义"
- 但截断通常发生在模型输出中途，包含的往往是半句、无效的语法片段
- 将这些片段作为 system prompt 补充上下文，会引入噪声甚至引导模型偏离

**Problem 2: 实际收益存疑**
- 即使重试成功，之前的部分内容已经发送给下游
- 下游仍然看到不完整的响应，只是"后面补了更多内容"
- 改善的是最终完整性，而非中间的断流感知

**Problem 3: 实现复杂度被低估**
- "将 fullResponse 作为上下文传入" 看似简单
- 但需要处理：fullResponse 的最大长度、编码问题、与原始 system prompt 的冲突
- buildShortResponseRetryRequest 需要大规模重构

**Verdict**: 截断上下文的有效性假设存疑且有引入噪声风险，HIGH。建议仅在部分内容超过最小长度阈值时才注入上下文。

---

### IDEA-6: 最小有效负载保证（Minimum Payload Guarantee）

| Field | Value |
|---|---|
| Severity | **HIGH** |
| Challenge Type | Assumption Validity |

**Problem 1: 人工内容欺骗下游**
- "Processing your request..." 不是真实模型输出，是伪造内容
- 下游的 Claude Code 可能在解析这个字符串，导致响应被污染
- 如果 Claude Code 将此文本当作真实模型输出进行后处理，会产生不可预测行为

**Problem 2: 与 Cursor API 的实际行为冲突**
- Cursor API 正常响应时，第一个 chunk 通常是 thinking 标签
- 在正常场景下，"3秒无内容则写入引导文本" 可能覆盖真实的 thinking
- 即便不覆盖，也会在 thinking 前面插入垃圾内容

**Problem 3: keepalive 已有类似效果**
- 当前 `: keepalive\n\n` 机制已在维持连接
- IDEA-6 声称"改善用户体验，减少白屏感知"，但 keepalive 注释下游不可见
- 如果下游能解析注释内容，则 keepalive 已经部分满足这个需求

**Verdict**: 注入人工内容有污染真实响应的风险，HIGH。建议删除引导文本，改为发送 SSE comment 进度消息（与 keepalive 类似但不声称是内容）。

---

### IDEA-7: 降级响应语义化（Semantic Fallback Response）

| Field | Value |
|---|---|
| Severity | **LOW** |
| Challenge Type | Competitive Analysis |

**Problem 1: SSE `event: error` 非标准**
- SSE 规范中 `event:` 字段标识事件类型，但 `error` 不是标准事件类型
- 浏览器/客户端 SSE 解析器可能将 `event: error` 当作普通事件处理，而非 HTTP 错误
- 标准 SSE 中没有 error 事件，error 通过 HTTP 状态码表达

**Problem 2: 下游实际不解析 error 事件**
- Claude Code 作为 SSE 消费者，接收 `event: error\ndata: {...}\n\n` 的行为未验证
- 如果 Claude Code 只看 HTTP 状态码和 content-type，error 事件可能被完全忽略

**Positive**: 向后兼容（未知事件类型可忽略），实现成本低，风险可控。

**Verdict**: SSE error 事件语义不够明确，建议改用 `event: degrade` 或 `event: status` 并携带 code/message 字段，LOW。

---

### IDEA-8: 响应完整性契约（Completeness Receipt）

| Field | Value |
|---|---|
| Severity | **MEDIUM** |
| Challenge Type | Competitive Analysis |

**Problem 1: 事后补救，无法实时修复**
- receipt 事件在 `res.end()` 前发送，此时流已经结束
- 下游在收到 receipt 后，无法回溯修改已经发送的内容
- 本质上是"日志/审计"功能，不是"修复"功能

**Problem 2: 下游契约假设未验证**
- "下游客户端会在收据阶段做最终验证" 是强假设
- 如果下游在收到部分内容后就认为超时断开，根本不会到达 receipt 阶段
- receipt 的价值完全依赖下游的配合行为

**Problem 3: 与 IDEA-3 的 meta 帧重叠**
- IDEA-3 的 meta 帧和 IDEA-8 的 receipt 事件功能高度重叠
- 如果都要实现，应合并为一个统一的流状态通知机制

**Verdict**: 作为可观测性工具有价值但不是修复方案，MEDIUM。建议作为调试/监控功能而非核心修复方案。

---

## Summary Table

| Idea | Severity | Key Challenge | GC Signal |
|------|----------|---------------|----------|
| IDEA-1 | **CRITICAL** | 循环依赖假设 + 性能惩罚 | REVISION_NEEDED |
| IDEA-2 | **HIGH** | 阈值无数据支撑 + 中途重试风险 | REVISION_NEEDED |
| IDEA-3 | **MEDIUM** | 下游兼容性未验证 + 协议不完整 | CONVERGED (w/ notes) |
| IDEA-4 | **MEDIUM** | 故障分类错误 + 集体惩罚风险 | CONVERGED (w/ notes) |
| IDEA-5 | **HIGH** | 截断上下文有效性存疑 + 实现复杂度低估 | REVISION_NEEDED |
| IDEA-6 | **HIGH** | 人工内容污染真实响应 | REVISION_NEEDED |
| IDEA-7 | **LOW** | SSE error 非标准语义 | CONVERGED (w/ notes) |
| IDEA-8 | **MEDIUM** | 事后补救非实时修复 | CONVERGED (w/ notes) |

## GC Signal

**REVISION_NEEDED** (5 ideas: IDEA-1 CRITICAL, IDEA-2 HIGH, IDEA-5 HIGH, IDEA-6 HIGH + others MEDIUM)

Top priorities for revision:
1. **IDEA-1** (CRITICAL): Remove circular probe logic. Consider probe-as-side-channel (separate endpoint, no prediction value for real request) or abandon.
2. **IDEA-6** (HIGH): Remove fake content injection. Replace with SSE comment-based progress signals.
3. **IDEA-5** (HIGH): Add minimum-length guard before injecting truncated content as context.
4. **IDEA-2** (HIGH): Provide empirical threshold data or make threshold adaptive, clarify retry mid-stream handling.
5. **IDEA-7** (LOW): Rename `event: error` to `event: degrade` with structured payload.

## Recommended Revised Priorities

After challenging, the viable ideas are:
1. **IDEA-7** (refined): Semantic degraded response with `event: degrade` - lowest risk, immediate value
2. **IDEA-8** (as debug tool): Completeness receipt for observability - not a fix but useful
3. **IDEA-3** (partial): Structured meta frames for status communication - if downstream coordination confirmed
4. **IDEA-4** (revised): Adaptive circuit breaker with shorter windows and half-open probing
