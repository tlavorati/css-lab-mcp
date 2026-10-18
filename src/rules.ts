import type { Page, CDPSession } from 'playwright-core';
import { callPage } from './browser.js';
import type { RuleDeclaration } from './types.js';

/** Properties that matter for hit testing, stacking and visibility. */
export const INTEREST_PROPERTIES = [
  'position', 'z-index', 'pointer-events', 'visibility', 'display', 'opacity',
  'transform', 'translate', 'rotate', 'scale', 'perspective', 'isolation', 'filter', 'backdrop-filter',
  'will-change', 'contain', 'container-type', 'mix-blend-mode', 'clip-path', 'mask', 'mask-image',
  'overflow', 'overflow-x', 'overflow-y',
  'inset', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'background', 'background-color', 'content',
];

interface StyleSheetHeader {
  styleSheetId: string;
  sourceURL: string;
  isInline: boolean;
  startLine: number;
  origin: string;
}

interface CdpProperty {
  name: string;
  value: string;
  important?: boolean;
  disabled?: boolean;
  parsedOk?: boolean;
  range?: { startLine: number; startColumn: number };
}

interface CdpStyle {
  styleSheetId?: string;
  cssProperties: CdpProperty[];
  range?: { startLine: number };
}

interface CdpRuleMatch {
  rule: {
    styleSheetId?: string;
    selectorList: { selectors: Array<{ text: string }>; text: string };
    origin: string;
    style: CdpStyle;
  };
  matchingSelectors: number[];
}

function matchesInterest(name: string, wanted: Set<string> | null): boolean {
  if (!wanted) return true;
  if (wanted.has(name)) return true;
  // longhand <-> shorthand (overflow-x when "overflow" asked, background-color when "background" asked, ...)
  const base = name.split('-')[0];
  return wanted.has(base) && ['overflow', 'background', 'mask', 'inset'].includes(base);
}

function markWinners(decls: RuleDeclaration[]): RuleDeclaration[] {
  const byProp = new Map<string, RuleDeclaration[]>();
  for (const d of decls) {
    const key = `${d.pseudo ?? ''}|${d.property}`;
    if (!byProp.has(key)) byProp.set(key, []);
    byProp.get(key)!.push(d);
  }
  for (const list of byProp.values()) {
    // Declarations arrive in ascending cascade order; !important beats normal.
    const important = list.filter((d) => d.important);
    const winner = (important.length ? important : list).at(-1);
    if (winner) winner.winning = true;
  }
  return decls;
}

class CdpRuleReader {
  private headers = new Map<string, StyleSheetHeader>();
  private rootId = 0;
  private constructor(private client: CDPSession) {}

  static async open(page: Page): Promise<CdpRuleReader> {
    const client = await page.context().newCDPSession(page);
    const reader = new CdpRuleReader(client);
    client.on('CSS.styleSheetAdded', (e: { header: StyleSheetHeader }) => {
      reader.headers.set(e.header.styleSheetId, e.header);
    });
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const doc = await client.send('DOM.getDocument', { depth: 0 });
    reader.rootId = doc.root.nodeId;
    return reader;
  }

  async close(): Promise<void> {
    await this.client.detach().catch(() => undefined);
  }

  private convert(style: CdpStyle, selector: string, origin: string, wanted: Set<string> | null, pseudo?: string): RuleDeclaration[] {
    const header = style.styleSheetId ? this.headers.get(style.styleSheetId) : undefined;
    const isAttr = selector === 'style attribute';
    const props = style.cssProperties.filter((p) => !p.disabled && p.parsedOk !== false);
    // CDP lists authored declarations (with a text range) plus their expanded longhands (without one).
    const hasRanges = props.some((p) => p.range);
    const out: RuleDeclaration[] = [];
    for (const p of props) {
      if (hasRanges && !p.range) continue;
      if (!matchesInterest(p.name, wanted)) continue;
      let line: number | null = null;
      // Ranges are relative to the stylesheet text; inline <style> sheets start mid-document.
      if (p.range) line = p.range.startLine + (header?.startLine ?? 0) + 1;
      const source = isAttr ? 'style attribute' : header?.sourceURL || (origin === 'user-agent' ? 'user-agent stylesheet' : 'constructed stylesheet');
      out.push({
        selector,
        property: p.name,
        value: p.value.replace(/\s*!important\s*$/i, ''),
        important: !!p.important,
        source,
        inline: isAttr || !!header?.isInline,
        line: isAttr ? null : line,
        origin: isAttr ? 'inline' : origin === 'regular' ? 'author' : origin === 'user-agent' ? 'user-agent' : 'other',
        winning: false,
        ...(pseudo ? { pseudo } : {}),
      });
    }
    return out;
  }

  async rulesFor(path: string, wanted: Set<string> | null, pseudoFilter?: string | null): Promise<RuleDeclaration[] | null> {
    let nodeId = 0;
    try {
      ({ nodeId } = await this.client.send('DOM.querySelector', { nodeId: this.rootId, selector: path }));
    } catch {
      return null;
    }
    if (!nodeId) return null;
    const m = (await this.client.send('CSS.getMatchedStylesForNode', { nodeId })) as unknown as {
      matchedCSSRules?: CdpRuleMatch[];
      inlineStyle?: CdpStyle;
      pseudoElements?: Array<{ pseudoType: string; matches: CdpRuleMatch[] }>;
    };
    const fromMatches = (matches: CdpRuleMatch[], pseudo?: string) => {
      const out: RuleDeclaration[] = [];
      for (const rm of matches) {
        const sels = rm.rule.selectorList.selectors;
        const matched = rm.matchingSelectors.map((i) => sels[i]?.text).filter(Boolean);
        const selector = matched.length ? matched.join(', ') : rm.rule.selectorList.text;
        out.push(...this.convert(rm.rule.style, selector, rm.rule.origin, wanted, pseudo));
      }
      return out;
    };
    let decls: RuleDeclaration[];
    if (pseudoFilter) {
      const type = pseudoFilter.replace(/^::?/, '');
      const pe = (m.pseudoElements ?? []).find((p) => p.pseudoType === type);
      decls = pe ? fromMatches(pe.matches, `::${type}`) : [];
    } else {
      decls = fromMatches(m.matchedCSSRules ?? []);
      if (m.inlineStyle) decls.push(...this.convert(m.inlineStyle, 'style attribute', 'inline', wanted));
    }
    return markWinners(decls);
  }
}

export interface RuleReader {
  method: 'cdp' | 'cssom';
  blockedStylesheets: string[];
  rulesFor(path: string, properties?: string[] | null, pseudo?: string | null): Promise<RuleDeclaration[]>;
  close(): Promise<void>;
}

/**
 * Creates a rule reader for the page. Uses the Chrome DevTools Protocol (works for cross-origin
 * stylesheets and file:// pages and gives source lines); falls back to the CSSOM otherwise.
 */
export async function createRuleReader(page: Page): Promise<RuleReader> {
  try {
    const cdp = await CdpRuleReader.open(page);
    return {
      method: 'cdp',
      blockedStylesheets: [],
      async rulesFor(path, properties, pseudo) {
        const wanted = properties === null ? null : new Set(properties ?? INTEREST_PROPERTIES);
        return (await cdp.rulesFor(path, wanted, pseudo)) ?? [];
      },
      close: () => cdp.close(),
    };
  } catch {
    const blocked = new Set<string>();
    return {
      method: 'cssom',
      get blockedStylesheets() {
        return [...blocked];
      },
      async rulesFor(path, properties, pseudo) {
        if (pseudo) return [];
        const res = await callPage<{ rules: Array<Omit<RuleDeclaration, 'winning' | 'inline' | 'origin'>>; blockedSheets: string[] }>(
          page,
          'cssomRules',
          { path, properties: properties ?? INTEREST_PROPERTIES },
        );
        res.blockedSheets.forEach((b) => blocked.add(b));
        return markWinners(
          res.rules.map((r) => ({
            ...r,
            inline: r.source === 'inline <style>' || r.source === 'style attribute',
            origin: r.source === 'style attribute' ? ('inline' as const) : ('author' as const),
            winning: false,
          })),
        );
      },
      close: async () => undefined,
    };
  }
}

/** Short, human-friendly location: "cards.css:12" or "page.html:8 (<style>)". */
export function formatSource(d: Pick<RuleDeclaration, 'source' | 'line' | 'inline'>): string {
  if (d.source === 'style attribute') return 'style attribute';
  let name = d.source;
  try {
    const u = new URL(d.source);
    name = u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch {
    /* not a URL */
  }
  const loc = d.line != null ? `${name}:${d.line}` : name;
  return d.inline ? `${loc} (<style>)` : loc;
}
