/**
 * proxy-agent.ts - 代理支持模块
 *
 * 职责：
 * 1. 根据 config.proxy 或 PROXY 环境变量创建 undici ProxyAgent，
 *    让 Node.js 原生 fetch() 能通过 HTTP/HTTPS 代理发送请求。
 * 2. FlareSolverr 兜底：当检测到 Cloudflare/Vercel 安全验证时，
 *    自动调用 FlareSolverr（headless Chrome）绕过挑战。
 *
 * Node.js 内置的 fetch (基于 undici) 不会自动读取 HTTP_PROXY / HTTPS_PROXY
 * 环境变量，必须显式传入 dispatcher (ProxyAgent) 才能走代理。
 */

import { ProxyAgent } from 'undici';
import { getConfig } from './config.js';

let cachedAgent: ProxyAgent | undefined;
let cachedVisionAgent: ProxyAgent | undefined;

/**
 * 获取代理 dispatcher（如果配置了 proxy）
 * 返回 undefined 表示不使用代理（直连）
 */
export function getProxyDispatcher(): ProxyAgent | undefined {
    const config = getConfig();
    const proxyUrl = config.proxy;

    if (!proxyUrl) return undefined;

    if (!cachedAgent) {
        console.log(`[Proxy] 使用全局代理: ${proxyUrl}`);
        cachedAgent = new ProxyAgent(proxyUrl);
    }

    return cachedAgent;
}

/**
 * 构建 fetch 的额外选项（包含 dispatcher）
 * 用法: fetch(url, { ...options, ...getProxyFetchOptions() })
 */
export function getProxyFetchOptions(): Record<string, unknown> {
    const dispatcher = getProxyDispatcher();
    return dispatcher ? { dispatcher } : {};
}

/**
 * ★ Vision 独立代理：优先使用 vision.proxy，否则回退到全局 proxy
 * Cursor API 国内可直连不需要代理，但图片分析 API 可能需要
 */
export function getVisionProxyFetchOptions(): Record<string, unknown> {
    const config = getConfig();
    const visionProxy = config.vision?.proxy;

    if (visionProxy) {
        if (!cachedVisionAgent) {
            console.log(`[Proxy] Vision 独立代理: ${visionProxy}`);
            cachedVisionAgent = new ProxyAgent(visionProxy);
        }
        return { dispatcher: cachedVisionAgent };
    }

    // 回退到全局代理
    return getProxyFetchOptions();
}

// ─── FlareSolverr 兜底 ──────────────────────────────────────────────────────

/**
 * 检测响应是否触发了 Cloudflare / Vercel 安全验证
 */
export function isCloudflareChallenge(status: number, body: string): boolean {
    return (
        status === 403 ||
        status === 429 ||
        (status === 200 && /cf-|cloudflare|vercel security|astro-cid|security checkpoint/i.test(body))
    );
}

/**
 * 处理 FlareSolverr 返回的完整 SSE 响应字符串，
 * 提取 data: 行并回调 onChunk，与原生流式处理保持一致。
 */
export async function processSSEStream(
    body: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onChunk: (event: any) => void,
    resetIdleTimer: () => void,
    signal?: AbortSignal,
): Promise<void> {
    const lines = body.split('\n');
    for (const line of lines) {
        if (signal?.aborted) break;
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        try {
            const event = JSON.parse(data);
            resetIdleTimer();
            onChunk(event);
        } catch {
            // ignore parse errors
        }
    }
}

/**
 * 通过 FlareSolverr 发送请求（使用 headless Chrome 自动绕过 CF 挑战）
 * 仅在检测到 CF 挑战后作为兜底调用
 */
export async function fetchWithFlareSolverr(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    } = {},
): Promise<{ ok: boolean; status: number; headers: Record<string, string>; body: string }> {
    const config = getConfig();
    const flareUrl = config.flareSolverrUrl || 'http://localhost:8191';

    const flareCmd = options.method === 'POST' || options.method === 'post'
        ? 'request.post'
        : 'request.get';

    const flareBody: Record<string, unknown> = {
        cmd: flareCmd,
        url,
        maxTimeout: (config.timeout || 120) * 1000,
        headers: options.headers || {},
    };
    if (flareCmd === 'request.post' && options.body) {
        flareBody.postData = options.body;
    }

    console.log(`[FlareSolverr] 绕过 CF 挑战，请求: ${url}`);

    const resp = await fetch(`${flareUrl}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flareBody),
        signal: options.signal,
    });

    const data = await resp.json() as {
        status: string;
        message?: string;
        solution?: {
            url: string;
            status: number;
            headers: Record<string, string>;
            response: string;
        };
    };

    if (data.status !== 'ok' || !data.solution) {
        const msg = data.message || 'Unknown FlareSolverr error';
        throw new Error(`FlareSolverr 失败: ${msg}`);
    }

    return {
        ok: data.solution.status >= 200 && data.solution.status < 300,
        status: data.solution.status,
        headers: data.solution.headers,
        body: data.solution.response,
    };
}
