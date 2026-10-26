import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Locator, type Page } from 'playwright';
import { BROWSER_H, BROWSER_W } from '@af/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';

let browserP: Promise<Browser> | null = null;
function getBrowser() {
  browserP ??= chromium.launch({ headless: config.browserHeadless });
  return browserP;
}

const lastFrames = new Map<string, { data: string; url: string }>();
export function browserFrames() {
  return Object.fromEntries(lastFrames);
}

class AgentBrowser {
  private ctx!: BrowserContext;
  page!: Page;
  private cdp!: CDPSession;
  private ready: Promise<void>;

  constructor(readonly agentId: string) {
    this.ready = this.init();
  }

  private async init() {
    const b = await getBrowser();
    this.ctx = await b.newContext({ viewport: { width: BROWSER_W, height: BROWSER_H }, locale: 'zh-CN' });
    this.page = await this.ctx.newPage();
    this.cdp = await this.ctx.newCDPSession(this.page);
    // CDP 屏幕流：页面每次重绘都会推一帧真实画面
    this.cdp.on('Page.screencastFrame', async (f) => {
      const url = this.page.url();
      lastFrames.set(this.agentId, { data: f.data, url });
      bus.emit({ t: 'frame', agentId: this.agentId, data: f.data, url });
      await this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: BROWSER_W, maxHeight: BROWSER_H, everyNthFrame: 1 });
  }

  async open(target: string) {
    await this.ready;
    let url = target;
    if (!/^[a-z]+:\/\//i.test(target)) {
      url = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(target) && !target.endsWith('.html')
        ? 'https://' + target
        : pathToFileURL(path.resolve(config.workspace, target)).href;
    }
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return `已打开 ${this.page.url()}（HTTP ${res?.status() ?? '-'}），标题：${await this.page.title()}\n\n${await this.read()}`;
  }

  /** 读取页面文字 + 可交互元素清单（带编号，供 click/type 使用） */
  async read() {
    await this.ready;
    const data = await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('a, button, input, textarea, select, [role=button], [onclick]'));
      const items: string[] = [];
      let idx = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        el.setAttribute('data-af-idx', String(idx));
        const label = (el.innerText || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim().slice(0, 60);
        const type = el.tagName.toLowerCase() + ((el as HTMLInputElement).type ? `[${(el as HTMLInputElement).type}]` : '');
        items.push(`[${idx}] ${type} ${label}`);
        idx++;
        if (idx >= 80) break;
      }
      return { text: document.body?.innerText ?? '', items };
    });
    const text = data.text.length > 6000 ? data.text.slice(0, 6000) + '\n...[截断]' : data.text;
    return `URL: ${this.page.url()}\n页面文字：\n${text}\n\n可交互元素：\n${data.items.join('\n') || '(无)'}`;
  }

  private locate(a: { index?: number; selector?: string; text?: string }): Locator {
    if (a.index !== undefined) return this.page.locator(`[data-af-idx="${a.index}"]`).first();
    if (a.selector) return this.page.locator(a.selector).first();
    if (a.text) return this.page.getByText(a.text, { exact: false }).first();
    throw new Error('需要提供 index、selector 或 text 之一');
  }

  private async showCursor(loc: Locator, action: 'click' | 'type') {
    const box = await loc.boundingBox().catch(() => null);
    if (box) bus.emit({ t: 'cursor', agentId: this.agentId, x: box.x + box.width / 2, y: box.y + box.height / 2, action });
  }

  async click(a: { index?: number; selector?: string; text?: string }) {
    await this.ready;
    const loc = this.locate(a);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await this.showCursor(loc, 'click');
    await new Promise((r) => setTimeout(r, 350));
    await loc.click({ timeout: 8000 });
    await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    return `已点击。\n\n${await this.read()}`;
  }

  async type(a: { index?: number; selector?: string; text?: string; value: string; submit?: boolean }) {
    await this.ready;
    const loc = this.locate(a);
    await this.showCursor(loc, 'type');
    await loc.click({ timeout: 8000 });
    await loc.fill('');
    // 逐字输入，屏幕上能看到真实的打字过程
    await loc.pressSequentially(a.value, { delay: 40 });
    if (a.submit) {
      await loc.press('Enter');
      await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 600));
    }
    return `已输入。\n\n${await this.read()}`;
  }

  async back() {
    await this.ready;
    await this.page.goBack({ timeout: 10000 }).catch(() => {});
    return this.read();
  }

  async close() {
    await this.ctx?.close().catch(() => {});
  }
}

const browsers = new Map<string, AgentBrowser>();

export function getBrowserFor(agentId: string) {
  let b = browsers.get(agentId);
  if (!b) {
    b = new AgentBrowser(agentId);
    browsers.set(agentId, b);
  }
  return b;
}

export async function closeAllBrowsers() {
  await Promise.all([...browsers.values()].map((b) => b.close()));
  browsers.clear();
  lastFrames.clear();
}
