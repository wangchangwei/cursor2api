/**
 * puppeteer-client.ts - Puppeteer 浏览器客户端
 *
 * 原理：
 * 1. 启动 headless Chrome 并导航到 cursor.com，解掉 CF 挑战
 * 2. 通过 page.evaluate() 在浏览器内发 fetch 请求
 *    → 自动继承浏览器 TLS 指纹 + cookies + CF session
 * 3. 解析 SSE，通过 exposeFunction 回调到 Node.js 层
 */

import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';

const CURSOR_API = 'https://cursor.com/api/chat';
const CURSOR_WWW = 'https://cursor.com';

let browser: Browser | null = null;
let page: Page | null = null;
let cfResolved = false;
let busy = false;
const pendingQueue: Array<() => void> = [];

function dequeue() {
    if (pendingQueue.length === 0) { busy = false; return; }
    busy = true;
    pendingQueue.shift()!();
}

async function ensureBrowser(): Promise<void> {
    if (page && browser) return;

    const config = getConfig();
    console.log('[Puppeteer] 启动 headless Chrome...');

    const proxy = config.proxy;
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
        ],
    };
    if (proxy) {
        const proxyUrl = proxy.startsWith('socks') ? proxy : proxy.replace(/^http:\/\//i, 'http://');
        launchOptions.args!.push(`--proxy-server=${proxyUrl}`);
    }

    const chromePath = config.fingerprint?.chromePath;
    if (chromePath) {
        launchOptions.executablePath = chromePath;
    } else {
        try {
            launchOptions.executablePath = puppeteer.executablePath();
        } catch { /* use bundled */ }
    }

    browser = await puppeteer.launch(launchOptions);

    const context = await browser.createBrowserContext();
    page = await context.newPage();

    // 捕获浏览器 console 输出（方便调试）
    page.on('console', msg => {
        if (msg.type() === 'error') {
            console.log(`[Puppeteer Browser ERROR] ${msg.text()}`);
        }
    });

    const ua = getConfig().fingerprint?.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    await page.setUserAgent(ua);

    console.log('[Puppeteer] 导航到 cursor.com 解 CF 挑战...');
    try {
        await page.goto(CURSOR_WWW, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000));
        cfResolved = true;
        console.log('[Puppeteer] ✅ CF 挑战已解决');
    } catch (e) {
        cfResolved = true;
        console.log('[Puppeteer] 导航完成，继续...');
    }
}

/**
 * 通过 Puppeteer 发 API 请求并流式回调
 */
export async function puppeteerFetch(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    await ensureBrowser();

    if (busy) {
        await new Promise<void>(resolve => pendingQueue.push(resolve));
    }
    busy = true;

    try {
        // 尝试用原始模型，如果遇到 "model not allowed" 则回退到 gemini-3-flash
        const result = await _doFetch(req, onChunk, signal);

        if (result.needsFallback && result.fallbackModel) {
            console.log(`[Puppeteer] 模型 ${req.model} 匿名会话不可用，尝试回退到 ${result.fallbackModel}...`);
            const fallbackReq = { ...req, model: result.fallbackModel };
            await _doFetch(fallbackReq, onChunk, signal);
        }
    } finally {
        busy = false;
        dequeue();
    }
}

async function _doFetch(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    signal?: AbortSignal,
): Promise<{ needsFallback: boolean; fallbackModel?: string }> {
    const chunkKey = `__c2a_chunk_${Date.now()}`;
    const doneKey = `__c2a_done_${Date.now()}`;

    let needsFallback = false;

    // 验证浏览器出口 IP（通过 cursor.com CSP 允许的域名）
    const ipKey = `__c2a_ip_${Date.now()}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).exposeFunction(ipKey, (ip: string) => {
        console.log(`[Puppeteer Browser IP]: ${ip}`);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).exposeFunction(chunkKey, (event: CursorSSEEvent) => {
        onChunk(event);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let doneResolve: (val: { needsFallback: boolean; fallbackModel?: string }) => void;
    const donePromise = new Promise<{ needsFallback: boolean; fallbackModel?: string }>(resolve => { doneResolve = resolve; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).exposeFunction(doneKey, (result: { needsFallback: boolean; fallbackModel?: string }) => {
        doneResolve(result);
    });

    const requestBody = JSON.stringify(req);
    const abortController = new AbortController();
    if (signal) {
        signal.addEventListener('abort', () => abortController.abort());
    }

    const ua = getConfig().fingerprint?.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

    try {
        await page!.evaluate(async (apiUrl: string, body: string, ck: string, dk: string, ipk: string, userAgent: string) => {
            try {
                // 查询浏览器出口 IP（ip.conceptualhq.com 在 cursor.com CSP 白名单中）
                try {
                    const ipResp = await fetch('https://ip.conceptualhq.com/');
                    const ip = await ipResp.text();
                    // @ts-ignore
                    window[ipk]?.(ip.trim());
                } catch { /* ignore */ }

                const resp = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'sec-ch-ua-platform': '"Windows"',
                        'x-path': '/api/chat',
                        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
                        'x-method': 'POST',
                        'sec-ch-ua-bitness': '"64"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-arch': '"x86"',
                        'sec-ch-ua-platform-version': '"19.0.0"',
                        'origin': 'https://cursor.com',
                        'sec-fetch-site': 'same-origin',
                        'sec-fetch-mode': 'cors',
                        'sec-fetch-dest': 'empty',
                        'referer': 'https://cursor.com/',
                        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'priority': 'u=1, i',
                        'x-is-human': '',
                        'user-agent': userAgent,
                    },
                    body,
                });

                if (!resp.ok) {
                    const text = await resp.text();
                    // 检测 "model not allowed" 错误（匿名会话）
                    if (resp.status === 400 && /model|allowed|invalid/i.test(text)) {
                        // @ts-ignore
                        window[dk]?.({ needsFallback: true, fallbackModel: 'google/gemini-3-flash' });
                        return;
                    }
                    // @ts-ignore
                    window[dk]?.({ needsFallback: false });
                    return;
                }

                const reader = resp.body!.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6).trim();
                        if (!data) continue;
                        try {
                            const event = JSON.parse(data);
                            // @ts-ignore
                            window[ck]?.(event);
                        } catch { /* ignore */ }
                    }
                }

                // @ts-ignore
                window[dk]?.({ needsFallback: false });
            } catch (e) {
                console.log('[Browser Puppeteer error]:', e);
                // @ts-ignore
                window[dk]?.({ needsFallback: false, error: String(e) });
            }
        }, CURSOR_API, requestBody, chunkKey, doneKey, ipKey, ua);

        const timeout = setTimeout(() => {
            doneResolve({ needsFallback: false });
        }, (getConfig().timeout || 120) * 1000);

        const result = await donePromise;
        clearTimeout(timeout);
        return result;

    } finally {
        try {
            await page!.evaluate((k1: string, k2: string, k3: string) => {
                // @ts-ignore
                delete window[k1];
                // @ts-ignore
                delete window[k2];
                // @ts-ignore
                delete window[k3];
            }, chunkKey, doneKey, ipKey);
        } catch { /* ignore */ }
    }
}

/**
 * 关闭浏览器
 */
export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
        page = null;
        cfResolved = false;
    }
}
