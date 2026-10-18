import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import type { Page } from 'playwright-core';
import { callPage, openPage, parseViewport, resolveTarget, UserInputError } from './browser.js';
import { diagnoseEarly, diagnoseProbe, type RawAnalyze, type RawPrepare, type RealClick } from './diagnose.js';
import { createRuleReader, INTEREST_PROPERTIES, type RuleReader } from './rules.js';
import type {
  ElementDetails,
  Fix,
  InspectOptions,
  InspectResult,
  InvisibleBlocker,
  PageOptions,
  RulesResult,
  ScanOptions,
  ScanResult,
  ScanViewportResult,
  StackAtPointResult,
  ViewportDiagnosis,
  ViewportSpec,
} from './types.js';

const DEFAULT_VIEWPORTS = ['desktop', 'mobile'];

function lazyRules(page: Page) {
  let reader: Promise<RuleReader> | null = null;
  return {
    get: () => (reader ??= createRuleReader(page)),
    async close() {
      if (reader) await (await reader).close();
    },
  };
}

async function highlightAndShoot(page: Page, boxes: Array<{ path: string; color: string; fill: string; text: string }>): Promise<Buffer> {
  await callPage(page, 'highlight', { boxes });
  const png = await page.screenshot({ type: 'png' });
  await callPage(page, 'clearHighlight');
  return png;
}

async function writePng(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function inspectViewport(
  url: string,
  selector: string,
  viewport: ViewportSpec,
  opts: InspectOptions,
  wantShot: boolean,
): Promise<{ diag: ViewportDiagnosis; png?: Buffer }> {
  const { page, close } = await openPage(url, viewport, opts);
  const rules = lazyRules(page);
  try {
    const prep = await callPage<RawPrepare>(page, 'prepare', { selector });
    if (prep.status === 'ERROR') throw new UserInputError(prep.error ?? 'Invalid selector');
    const fetch = async (path: string, props: string[], pseudo?: string | null) => (await rules.get()).rulesFor(path, props, pseudo);

    let diag: ViewportDiagnosis;
    if (prep.status !== 'PROBE') {
      diag = await diagnoseEarly(viewport, selector, prep, fetch);
    } else {
      const points = prep.points ?? [];
      const clicks: RealClick[] = [];
      if (!opts.noRealClick) {
        await callPage(page, 'installCapture');
        try {
          for (const pt of points) {
            await page.mouse.click(pt.x, pt.y);
            clicks.push(await callPage<RealClick>(page, 'takeClick'));
          }
        } finally {
          await callPage(page, 'removeCapture');
        }
      }
      const analysis = await callPage<RawAnalyze>(page, 'analyze', { points });
      diag = await diagnoseProbe(viewport, prep, analysis, clicks, fetch);
    }

    let png: Buffer | undefined;
    if (wantShot) {
      const boxes = [];
      if (diag.target?.path) boxes.push({ path: diag.target.path, color: '#16a34a', fill: 'rgba(22,163,74,0.12)', text: 'target' });
      if (diag.occluder?.path) {
        boxes.push({ path: diag.occluder.path, color: '#dc2626', fill: 'rgba(220,38,38,0.10)', text: `occluder${diag.occluder.invisible.invisible ? ' (invisible)' : ''}` });
      }
      png = await highlightAndShoot(page, boxes);
    }
    return { diag, png };
  } finally {
    await rules.close().catch(() => undefined);
    await close();
  }
}

/**
 * Diagnoses why an element can (not) be clicked, using a real Chromium:
 * hit testing at several points, real mouse clicks, stacking-context analysis
 * and CSS rule attribution via the DevTools protocol.
 */
export async function inspectClickTarget(target: string, selector: string, opts: InspectOptions = {}): Promise<InspectResult> {
  if (!selector || !selector.trim()) throw new UserInputError('A CSS selector for the target element is required.');
  const url = resolveTarget(target);
  const viewports = (opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS).map(parseViewport);
  const results: Array<{ diag: ViewportDiagnosis; png?: Buffer }> = [];
  for (const vp of viewports) results.push(await inspectViewport(url, selector, vp, opts, !!opts.screenshot));

  const primaryIdx = Math.max(0, results.findIndex((r) => r.diag.verdict !== 'OK'));
  const primary = results[primaryIdx].diag;
  const out: InspectResult = {
    url,
    selector,
    verdict: primary.verdict,
    clickable: primary.clickable && results.every((r) => r.diag.verdict === 'OK' || r.diag.clickable),
    summary: viewports.length > 1 ? `[${primary.viewport.name}] ${primary.summary}` : primary.summary,
    primaryViewport: primary.viewport.name,
    fixes: primary.fixes,
    viewports: results.map((r) => r.diag),
  };
  if (opts.screenshot && results[primaryIdx].png) {
    await writePng(opts.screenshot, results[primaryIdx].png!);
    out.screenshot = opts.screenshot;
    primary.screenshot = opts.screenshot;
  }
  return out;
}

/** Lists every element under a viewport point (topmost first) with stacking information. */
export async function elementStackAtPoint(
  target: string,
  x: number,
  y: number,
  opts: PageOptions & { viewport?: string | ViewportSpec; limit?: number } = {},
): Promise<StackAtPointResult> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new UserInputError('x and y must be numbers (CSS pixels, viewport coordinates).');
  const url = resolveTarget(target);
  const viewport = parseViewport(opts.viewport ?? 'desktop');
  const { page, close } = await openPage(url, viewport, opts);
  try {
    const elements = await callPage<StackAtPointResult['elements']>(page, 'stackAt', { x, y, limit: opts.limit ?? 12 });
    return { url, viewport, x, y, elements };
  } finally {
    await close();
  }
}

/** Returns the CSS declarations (selector, stylesheet, line) that apply to an element. */
export async function cssRulesForElement(
  target: string,
  selector: string,
  opts: PageOptions & { viewport?: string | ViewportSpec; properties?: string[] | 'all'; pseudo?: string } = {},
): Promise<RulesResult> {
  const url = resolveTarget(target);
  const viewport = parseViewport(opts.viewport ?? 'desktop');
  const { page, close } = await openPage(url, viewport, opts);
  const rules = lazyRules(page);
  try {
    const found = await callPage<{ error?: string; notFound?: boolean; path?: string; label?: string; matchCount?: number }>(page, 'elementPath', { selector });
    if (found.error) throw new UserInputError(found.error);
    const reader = await rules.get();
    if (found.notFound || !found.path) {
      return { url, selector, element: null, matchCount: 0, method: reader.method, rules: [] };
    }
    const props = opts.properties === 'all' ? null : opts.properties?.length ? opts.properties : INTEREST_PROPERTIES;
    const decls = await reader.rulesFor(found.path, props, opts.pseudo ?? null);
    const res: RulesResult = { url, selector, element: found.label ?? null, matchCount: found.matchCount ?? 1, method: reader.method, rules: decls };
    if (reader.method === 'cssom' && reader.blockedStylesheets.length) res.blockedStylesheets = reader.blockedStylesheets;
    return res;
  } finally {
    await rules.close().catch(() => undefined);
    await close();
  }
}

interface RawScan {
  viewportWidth: number;
  viewportHeight: number;
  step: number;
  gridPoints: number;
  blockers: Array<Omit<InvisibleBlocker, 'realClick' | 'rules' | 'fixes'>>;
}

function blockerFixes(b: { occluder: ElementDetails; pseudo: string | null; coveredElements: Array<{ selector: string }> }): Fix[] {
  const sel = b.occluder.selector + (b.pseudo ?? '');
  const fixes: Fix[] = [
    { description: `Let clicks pass through ${sel} (it paints nothing, so this has no visual effect).`, css: `${sel} {\n  pointer-events: none;\n}` },
  ];
  if (!b.pseudo) {
    fixes.push({ description: `If it is a leftover overlay/backdrop, remove it from the page while inactive.`, css: `${b.occluder.selector} {\n  display: none;\n}` });
  } else {
    fixes.push({ description: `Or lift the covered element above the pseudo-element.`, css: `${b.coveredElements[0]?.selector ?? 'a, button'} {\n  position: relative;\n  z-index: 1;\n}` });
  }
  return fixes;
}

/**
 * Sweeps the viewport on a grid and reports visually invisible elements that
 * intercept clicks meant for a visible interactive element underneath.
 */
export async function scanInvisibleBlockers(target: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const url = resolveTarget(target);
  const viewports = (opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS).map(parseViewport);
  const step = Math.max(4, Math.min(200, Math.round(opts.step ?? 24)));
  const out: ScanViewportResult[] = [];
  for (const vp of viewports) {
    const { page, close } = await openPage(url, vp, opts);
    const rules = lazyRules(page);
    try {
      const raw = await callPage<RawScan>(page, 'scan', { step });
      const blockers: InvisibleBlocker[] = [];
      for (const b of raw.blockers) {
        let realClick: InvisibleBlocker['realClick'] = null;
        if (!opts.noRealClick && b.coveredElements[0]) {
          await callPage(page, 'setTargetPath', { path: b.coveredElements[0].path });
          await callPage(page, 'installCapture');
          try {
            await page.mouse.click(b.samplePoint.x, b.samplePoint.y);
            const rc = await callPage<RealClick>(page, 'takeClick');
            realClick = { receivedBy: rc.receivedBy, reachedCoveredElement: rc.reachedTarget };
          } finally {
            await callPage(page, 'removeCapture');
          }
        }
        // A real click that reaches the covered element means the grid hit test was a false positive.
        if (realClick?.reachedCoveredElement) continue;
        const reader = await rules.get();
        const props = ['opacity', 'background', 'background-color', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'width', 'height', 'z-index', 'pointer-events', 'content', 'display', 'visibility'];
        const decls = await reader.rulesFor(b.occluder.path, props, b.pseudo);
        const rank = (prop: string) => {
          const i = ['opacity', 'background', 'background-color', 'content', 'pointer-events', 'visibility', 'position', 'z-index'].indexOf(prop);
          return i < 0 ? 99 : i;
        };
        const winning = decls.filter((d) => d.winning && d.origin !== 'user-agent').sort((x, y) => rank(x.property) - rank(y.property));
        blockers.push({ ...b, realClick, rules: winning, fixes: blockerFixes(b) });
      }
      const res: ScanViewportResult = { viewport: vp, step: raw.step, gridPoints: raw.gridPoints, blockers };
      if (opts.screenshot) {
        const ext = extname(opts.screenshot) || '.png';
        const file = viewports.length > 1 ? opts.screenshot.slice(0, opts.screenshot.length - extname(opts.screenshot).length) + `-${vp.name}${ext}` : opts.screenshot;
        const png = await highlightAndShoot(
          page,
          blockers.map((b, i) => ({ path: b.occluder.path, color: '#dc2626', fill: 'rgba(220,38,38,0.18)', text: `#${i + 1} ${b.occluder.selector}${b.pseudo ?? ''}` })),
        );
        await writePng(file, png);
        res.screenshot = file;
      }
      out.push(res);
    } finally {
      await rules.close().catch(() => undefined);
      await close();
    }
  }
  const found = out.reduce((n, v) => n + v.blockers.length, 0);
  const uniq = new Set(out.flatMap((v) => v.blockers.map((b) => b.occluder.selector + (b.pseudo ?? ''))));
  return {
    url,
    found,
    summary: found
      ? `Found ${uniq.size} invisible element(s) intercepting clicks: ${[...uniq].join(', ')}.`
      : 'No invisible click blockers found in the scanned viewports.',
    viewports: out,
  };
}
