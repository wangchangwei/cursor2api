/**
 * truncation-detector.ts — Unified truncation detection and retry strategy
 *
 * Replaces duplicated detection logic across handler.ts and openai-handler.ts.
 * Single source of truth for: isTruncated, looksLikeThinkingFragment, detectTruncation.
 */

import { hasToolCalls } from './converter.js';

// ==================== Types ====================

export type TruncationType =
    | 'partial_tool'   // Tool call block unclosed
    | 'thinking_only'  // Only thinking fragment, no tool call
    | 'empty'         // Empty or near-empty
    | 'valid';        // Normal response

export type RetryStrategy =
    | 'continuation'  // Inject thinking fragment as context, retry
    | 'probe'         // Add probe user message, retry
    | 'fallback'      // Synthesize fallback tool call
    | 'none';         // Return as-is

export interface TruncationDetection {
    type: TruncationType;
    /** Short trimmed text for heuristic checks */
    trimmed: string;
    /** Whether the upstream was cut off by max_tokens (precise signal) */
    upstreamMaxTokens: boolean;
    shouldRetry: boolean;
    strategy: RetryStrategy;
}

// ==================== Constants ====================

/** Minimum fragment length (chars) for contextual retry — below this, fall back */
export const MIN_FRAGMENT_RETRY_LEN = 10;
/** Below this length and no digits → immediate fallback (not even thinking fragment) */
export const MIN_CONTENT_LEN = 3;
/** Thinking fragment heuristic: short response ending with punctuation */
export const THINKING_FRAGMENT_MAX_LEN = 200;

// ==================== isTruncated ====================

/**
 * Detect if text contains unclosed code/tool blocks indicating a stream truncation.
 * Moved from handler.ts — single implementation for both handlers.
 */
export function isTruncated(text: string): boolean {
    if (!text || text.trim().length === 0) return false;
    const trimmed = text.trimEnd();

    // 末尾是未完成的 json action 开始标记（如 "```jso" "```json"）
    if (/```j[\w ]{0,10}$/.test(trimmed)) return true;

    // ```json action 块是否未闭合（截断发生在工具调用参数中间）
    const jsonActionOpens = (trimmed.match(/```json\s+action/g) || []).length;
    if (jsonActionOpens > 0) {
        const jsonActionBlocks = trimmed.match(/```json\s+action[\s\S]*?```/g) || [];
        if (jsonActionOpens > jsonActionBlocks.length) return true;
        return false;
    }

    // 无工具调用时的通用截断检测（纯文本响应）
    const lineStartCodeBlocks = (trimmed.match(/^```/gm) || []).length;
    if (lineStartCodeBlocks % 2 !== 0) return true;

    // XML/HTML 标签未闭合
    const openTags = (trimmed.match(/^<[a-zA-Z]/gm) || []).length;
    const closeTags = (trimmed.match(/^<\/[a-zA-Z]/gm) || []).length;
    if (openTags > closeTags + 1) return true;

    // 以逗号、分号、冒号、开括号结尾（明显未完成）
    if (/[,;:\[{(]\s*$/.test(trimmed)) return true;

    // 长响应以反斜杠 + n 结尾（JSON 字符串中间被截断）
    if (trimmed.length > 2000 && /\\n?\s*$/.test(trimmed) && !trimmed.endsWith('```')) return true;

    // 短响应且以小写字母结尾不判断
    if (trimmed.length < 500 && /[a-z]$/.test(trimmed)) return false;

    return false;
}

// ==================== looksLikeThinkingFragment ====================

/**
 * Heuristic: does this text look like a thinking fragment (not a real response)?
 * Uses stopReason signal when available, falls back to string patterns.
 *
 * @param text        - full response text
 * @param stopReason  - upstream finish reason ('max_tokens', 'end_turn', etc.)
 * @param hasTools    - whether tools were requested
 */
export function looksLikeThinkingFragment(
    text: string,
    stopReason: string,
    hasTools: boolean,
): boolean {
    if (!hasTools) return false;
    if (hasToolCalls(text)) return false;
    const t = text.trim();
    if (t.length === 0) return false;

    // max_tokens is the precise truncation signal — highest priority
    if (stopReason === 'max_tokens') return true;

    // String heuristic: short response ending with punctuation
    if (t.length < THINKING_FRAGMENT_MAX_LEN && /[：:,，。.…]$/.test(t)) return true;

    return false;
}

// ==================== detectTruncation ====================

/**
 * Unified truncation detection + retry strategy decision.
 * Call this after the stream completes to decide what action to take.
 *
 * @param text        - full response text
 * @param stopReason  - upstream finish reason
 * @param hasTools    - whether tools were requested
 */
export function detectTruncation(
    text: string,
    stopReason: string,
    hasTools: boolean,
): TruncationDetection {
    const trimmed = text.trim();
    const upstreamMaxTokens = stopReason === 'max_tokens';
    const truncated = isTruncated(text);
    const hasCalls = hasToolCalls(text);
    const thinkingFrag = looksLikeThinkingFragment(text, stopReason, hasTools);

    // Case 1: partial tool call
    if (hasTools && (truncated || (hasCalls === false && upstreamMaxTokens))) {
        return {
            type: 'partial_tool',
            trimmed,
            upstreamMaxTokens,
            shouldRetry: true,
            strategy: thinkingFrag && trimmed.length >= MIN_FRAGMENT_RETRY_LEN
                ? 'continuation'
                : 'fallback',
        };
    }

    // Case 2: thinking fragment only
    if (hasTools && !hasCalls && thinkingFrag) {
        if (trimmed.length >= MIN_FRAGMENT_RETRY_LEN) {
            return {
                type: 'thinking_only',
                trimmed,
                upstreamMaxTokens,
                shouldRetry: true,
                strategy: 'continuation',
            };
        }
        // Short fragment — immediate fallback
        return {
            type: 'thinking_only',
            trimmed,
            upstreamMaxTokens,
            shouldRetry: false,
            strategy: 'fallback',
        };
    }

    // Case 3: empty / near-empty
    if (hasTools && trimmed.length < MIN_CONTENT_LEN && !trimmed.match(/\d/)) {
        return {
            type: 'empty',
            trimmed,
            upstreamMaxTokens,
            shouldRetry: true,
            strategy: 'probe',
        };
    }

    // Case 4: valid response
    return {
        type: 'valid',
        trimmed,
        upstreamMaxTokens,
        shouldRetry: false,
        strategy: 'none',
    };
}
