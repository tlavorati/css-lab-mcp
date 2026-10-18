import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { PAGE_SCRIPT } from './page-script.js';
import type { PageOptions, PreAction, ViewportSpec } from './types.js';

export const INSTALL_HINT =
  'Chromium for Playwright is not installed. Run:\n' +
  '  npx -p css-lab-mcp css-lab install-browser   (installs the exact Chromium build this package expects)\n' +
  'or\n' +
  '  npx playwright install chromium\n' +
  'Alternatively set CSS_LAB_CHROMIUM_PATH to a Chrome/Chromium executable.';

export class BrowserNotInstalledError extends Error {
  constructor(detail?: string) {
    super(INSTALL_HINT + (detail ? `\n\nLast launch error: ${detail.split('\n')[0]}` : ''));
    this.name = 'BrowserNotInstalledError';
  }
}

export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

let browserPromise: Promise<Browser> | null = null;

function isMissingExecutable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|executable doesn't exist|Failed to launch|ENOENT|is not found at|Chromium distribution .* is not found/i.test(msg);
}

async function launch(): Promise<Browser> {
  const envPath = process.env.CSS_LAB_CHROMIUM_PATH;
  if (envPath) {
    try {
      return await chromium.launch({ headless: true, executablePath: envPath });
    } catch (err) {
      if (!isMissingExecutable(err)) throw err;
      throw new BrowserNotInstalledError(`CSS_LAB_CHROMIUM_PATH=${envPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let lastError: unknown;
  // 1) the Chromium build bundled for playwright-core, 2) an installed Google Chrome / Edge.
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }] as const) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch (err) {
      lastError = err;
      if (!isMissingExecutable(err)) throw err;
    }
  }
  throw new BrowserNotInstalledError(lastError instanceof Error ? lastError.message : String(lastError));
}

/** Returns the process-wide shared browser, launching it on first use. */
export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** Closes the shared browser (safe to call multiple times). */
export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {
    /* already gone */
  }
}

/** Accepts http(s)/file/data/about URLs or a local file path (relative to cwd). */
export function resolveTarget(target: string): string {
  if (/^(https?|file|data|about):/i.test(target)) return target;
  const abs = resolve(process.cwd(), target);
  if (!existsSync(abs)) {
    throw new UserInputError(`Target not found: "${target}" is neither a URL (http/https/file) nor an existing file.`);
  }
  return pathToFileURL(abs).href;
}

export const VIEWPORTS: Record<string, ViewportSpec> = {
  desktop: { name: 'desktop', width: 1280, height: 900, isMobile: false },
  mobile: { name: 'mobile', width: 390, height: 844, isMobile: true },
  tablet: { name: 'tablet', width: 768, height: 1024, isMobile: true },
};

export function parseViewport(v: string | ViewportSpec): ViewportSpec {
  if (typeof v !== 'string') return v;
  const key = v.trim().toLowerCase();
  if (VIEWPORTS[key]) return VIEWPORTS[key];
  const m = key.match(/^(\d{2,5})x(\d{2,5})$/);
  if (m) return { name: key, width: Number(m[1]), height: Number(m[2]), isMobile: false };
  throw new UserInputError(`Unknown viewport "${v}". Use desktop, mobile, tablet or WIDTHxHEIGHT (e.g. 1024x768).`);
}

/** Parses CLI-style pre-actions: "click:.sel", "hover:.sel", "focus:.sel", "scroll:.sel", "wait:.sel", "wait:500", "press:Escape". */
export function parsePreAction(s: string): PreAction {
  const i = s.indexOf(':');
  if (i <= 0) throw new UserInputError(`Invalid pre-action "${s}". Expected "type:value", e.g. "click:.menu-toggle".`);
  const type = s.slice(0, i).trim().toLowerCase();
  const value = s.slice(i + 1).trim();
  if (!value) throw new UserInputError(`Pre-action "${s}" has no value.`);
  switch (type) {
    case 'click':
    case 'hover':
    case 'focus':
    case 'scroll':
      return { type, selector: value };
    case 'wait':
      return /^\d+$/.test(value) ? { type: 'wait', ms: Number(value) } : { type: 'wait', selector: value };
    case 'press':
      return { type: 'press', key: value };
    default:
      throw new UserInputError(`Unknown pre-action type "${type}". Use click, hover, focus, scroll, wait or press.`);
  }
}

async function runPreActions(page: Page, actions: PreAction[], timeout: number): Promise<void> {
  for (const a of actions) {
    const desc = JSON.stringify(a);
    try {
      switch (a.type) {
        case 'click':
          await page.click(a.selector, { timeout });
          break;
        case 'hover':
          await page.hover(a.selector, { timeout });
          break;
        case 'focus':
          await page.focus(a.selector, { timeout });
          break;
        case 'scroll':
          await page.locator(a.selector).first().scrollIntoViewIfNeeded({ timeout });
          break;
        case 'wait':
          if (a.selector) await page.waitForSelector(a.selector, { state: 'attached', timeout });
          else await page.waitForTimeout(Math.min(a.ms ?? 0, 60_000));
          break;
        case 'press':
          await page.keyboard.press(a.key);
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new UserInputError(`Pre-action ${desc} failed: ${msg}`);
    }
  }
}

export interface OpenedPage {
  page: Page;
  context: BrowserContext;
  close: () => Promise<void>;
}

/** Opens a fresh context + page at the viewport, navigates, runs pre-actions and injects the probe script. */
export async function openPage(url: string, viewport: ViewportSpec, opts: PageOptions = {}): Promise<OpenedPage> {
  const browser = await getBrowser();
  const timeout = opts.timeoutMs ?? 30_000;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    deviceScaleFactor: viewport.isMobile ? 2 : 1,
    reducedMotion: 'reduce',
  });
  const close = async () => {
    await context.close().catch(() => undefined);
  };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    try {
      await page.goto(url, { waitUntil: opts.waitUntil ?? 'load', timeout });
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new UserInputError(`Could not load ${url}: ${msg}`);
    }
    await runPreActions(page, opts.preActions ?? [], Math.min(timeout, 10_000));
    await page.evaluate(PAGE_SCRIPT);
    return { page, context, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Calls a method of the injected `window.__cssLab__` API. */
export async function callPage<T>(page: Page, method: string, arg: unknown = {}): Promise<T> {
  return (await page.evaluate(`window.__cssLab__.${method}(${JSON.stringify(arg)})`)) as T;
}
