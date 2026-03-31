/**
 * 检测到 Claude Code / 工具链典型硬错误时，追加「拆分任务 → 重规划 → 重执行」指引，
 * 并在输出 token 上限类错误上建议 stop_reason=max_tokens 以便客户端自动续写。
 */

export type SplitTaskRecoveryKind = 'output_token_limit' | 'invalid_tool';

const OUTPUT_TOKEN_PATTERNS: RegExp[] = [
    /exceeded the [\d,]+\s*output token maximum/i,
    /output token maximum/i,
    /CLAUDE_CODE_MAX_OUTPUT_TOKENS/i,
    /32000\s*output\s*token/i,
];

const INVALID_TOOL_PATTERNS: RegExp[] = [
    /Invalid tool parameters/i,
    /invalid parameters for tool/i,
    /API Error:.*tool/i,
];

export function detectSplitTaskRecoveryKind(text: string): SplitTaskRecoveryKind | null {
    if (!text || text.length < 8) return null;
    if (OUTPUT_TOKEN_PATTERNS.some((r) => r.test(text))) return 'output_token_limit';
    if (INVALID_TOOL_PATTERNS.some((r) => r.test(text))) return 'invalid_tool';
    return null;
}

export function buildSplitTaskRecoveryBlock(kind: SplitTaskRecoveryKind): string {
    const core = `**[Proxy recovery — split & replan]**
The model or tool runtime reported a hard limit or validation failure. **Do not repeat the same monolithic step.**

1. **Split**: break work into the smallest next actions (one file, one endpoint, or one minimal tool call).
2. **Re-plan**: write 2–5 ordered subtasks; execute **only the first** in your next turn.
3. **Re-run**: use a single tool call with **minimal** parameters; avoid huge \`Write\` payloads in one shot.`;

    if (kind === 'output_token_limit') {
        return `${core}
4. **Output budget**: if hits output cap again, raise the client limit, e.g. \`export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000\` (or your team default), then continue with smaller per-step outputs.`;
    }
    return `${core}
4. **Tool args**: re-open the tool schema, fix required fields and types, then call again with the **smallest valid** payload.`;
}

/** 若命中容错模式，返回要追加在正文后的后缀（含前导换行） */
export function getSplitTaskRecoverySuffix(fullText: string): {
    suffix: string;
    kind: SplitTaskRecoveryKind;
    forceMaxTokensStop: boolean;
} | null {
    const kind = detectSplitTaskRecoveryKind(fullText);
    if (!kind) return null;
    return {
        suffix: `\n\n---\n\n${buildSplitTaskRecoveryBlock(kind)}`,
        kind,
        forceMaxTokensStop: kind === 'output_token_limit',
    };
}
