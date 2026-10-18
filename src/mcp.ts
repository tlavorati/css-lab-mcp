#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeBrowser } from './browser.js';
import { cssRulesForElement, elementStackAtPoint, inspectClickTarget, scanInvisibleBlockers } from './inspect.js';
import type { PreAction } from './types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const target = z
  .string()
  .min(1)
  .describe('Page to load: an http(s):// URL (e.g. a local dev server) or a path to a local .html file (absolute, or relative to the server working directory).');

const viewport = z
  .string()
  .describe('"desktop" (1280x900), "mobile" (390x844, touch), "tablet" (768x1024) or "WIDTHxHEIGHT".');

const preActions = z
  .array(
    z.object({
      type: z.enum(['click', 'hover', 'focus', 'scroll', 'wait', 'press']).describe('Action to run before inspecting.'),
      selector: z.string().optional().describe('CSS selector for click/hover/focus/scroll, or the element to wait for with "wait".'),
      ms: z.number().int().min(0).max(60000).optional().describe('Milliseconds to wait (type "wait" without selector).'),
      key: z.string().optional().describe('Key for "press", e.g. "Escape" or "ArrowDown".'),
    }),
  )
  .optional()
  .describe('Steps that bring the page into the state to inspect, e.g. [{"type":"click","selector":".menu-toggle"},{"type":"wait","selector":".menu.open"}].');

function toPreActions(list: Array<{ type: string; selector?: string; ms?: number; key?: string }> | undefined): PreAction[] {
  return (list ?? []).map((a) => {
    switch (a.type) {
      case 'press':
        if (!a.key) throw new Error('pre-action "press" requires "key"');
        return { type: 'press', key: a.key };
      case 'wait':
        return a.selector ? { type: 'wait', selector: a.selector } : { type: 'wait', ms: a.ms ?? 0 };
      default:
        if (!a.selector) throw new Error(`pre-action "${a.type}" requires "selector"`);
        return { type: a.type as 'click' | 'hover' | 'focus' | 'scroll', selector: a.selector };
    }
  });
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }] };
}

const server = new McpServer({ name: 'css-lab', version: pkg.version });

server.registerTool(
  'inspect_click_target',
  {
    title: 'Why can\'t this element be clicked?',
    description:
      'Loads the page in real Chromium and diagnoses whether a click on the element matching `selector` actually reaches it. ' +
      'Uses elementFromPoint at 9 points plus real mouse clicks, then explains the cause with evidence: ' +
      'verdict (OK, INVISIBLE_OCCLUDER, COVERED_BY_SIBLING_STACKING_CONTEXT, COVERED_BY_POSITIONED_ELEMENT, POINTER_EVENTS_NONE, INVISIBLE, OUTSIDE_VIEWPORT_OR_CLIPPED, ZERO_SIZE, NOT_FOUND), ' +
      'the element that receives the click instead (and whether it is visually invisible), the stacking-context chain, ' +
      'the exact CSS rules responsible (selector, stylesheet, line) and 1-3 minimal fixes. ' +
      'Use this instead of guessing z-index values. Use preActions to open menus/modals first.',
    inputSchema: {
      target,
      selector: z.string().min(1).describe('CSS selector of the element the user wants to click (first match is inspected).'),
      viewports: z.array(viewport).optional().describe('Viewports to test. Default ["desktop","mobile"].'),
      preActions,
      screenshotPath: z.string().optional().describe('Optional PNG path; target outlined green, occluder red.'),
    },
  },
  async (args) => {
    try {
      return ok(
        await inspectClickTarget(args.target, args.selector, {
          viewports: args.viewports,
          preActions: toPreActions(args.preActions),
          screenshot: args.screenshotPath,
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'scan_invisible_blockers',
  {
    title: 'Find invisible elements eating clicks',
    description:
      'Sweeps the viewport on a grid in real Chromium and finds visually invisible elements (opacity 0, transparent empty wrappers, ' +
      'leftover modal backdrops, positioned ::before/::after overlays, zero-alpha layers) that sit on top of visible interactive elements ' +
      '(links, buttons, inputs, [role=button], [onclick], labels...). Each finding is confirmed with a real mouse click and grouped by occluder, ' +
      'with its rect, why it is invisible, the elements it covers, the CSS rules responsible and suggested fixes. ' +
      'Use when "some buttons/links do nothing" or clicks behave strangely and the cause is not visible.',
    inputSchema: {
      target,
      viewports: z.array(viewport).optional().describe('Viewports to scan. Default ["desktop","mobile"].'),
      step: z.number().int().min(4).max(200).optional().describe('Grid step in CSS pixels (default 24). Smaller finds smaller blockers but is slower.'),
      preActions,
      screenshotPath: z.string().optional().describe('Optional PNG path; blockers outlined red (one file per viewport when several).'),
    },
  },
  async (args) => {
    try {
      return ok(
        await scanInvisibleBlockers(args.target, {
          viewports: args.viewports,
          step: args.step,
          preActions: toPreActions(args.preActions),
          screenshot: args.screenshotPath,
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'element_stack_at_point',
  {
    title: 'Elements under a point',
    description:
      'Lists every element under a viewport coordinate (document.elementsFromPoint), topmost first, with position, z-index, ' +
      'pointer-events, opacity, whether it creates a stacking context (and why), its stacking-context chain, and whether it is visually invisible.',
    inputSchema: {
      target,
      x: z.number().describe('X in CSS pixels, relative to the viewport.'),
      y: z.number().describe('Y in CSS pixels, relative to the viewport.'),
      viewport: viewport.optional().describe('Viewport (default "desktop").'),
      preActions,
    },
  },
  async (args) => {
    try {
      return ok(await elementStackAtPoint(args.target, args.x, args.y, { viewport: args.viewport, preActions: toPreActions(args.preActions) }));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'css_rules_for_element',
  {
    title: 'CSS rules for an element',
    description:
      'Returns the CSS declarations that apply to the element matching `selector`, with selector, stylesheet URL (works for cross-origin and file:// stylesheets via the DevTools protocol), ' +
      '1-based source line and which declaration wins the cascade. Defaults to stacking/visibility properties (position, z-index, pointer-events, opacity, transform, overflow, ...).',
    inputSchema: {
      target,
      selector: z.string().min(1).describe('CSS selector of the element (first match).'),
      properties: z.array(z.string()).optional().describe('Properties to report, e.g. ["z-index","position"]. Use ["*"] for all.'),
      pseudo: z.string().optional().describe('Pseudo-element to inspect instead, e.g. "::after".'),
      viewport: viewport.optional().describe('Viewport (default "desktop"); media queries differ per viewport.'),
      preActions,
    },
  },
  async (args) => {
    try {
      const props = args.properties?.includes('*') ? 'all' : args.properties;
      return ok(
        await cssRulesForElement(args.target, args.selector, {
          properties: props,
          pseudo: args.pseudo,
          viewport: args.viewport,
          preActions: toPreActions(args.preActions),
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

async function shutdown(code = 0): Promise<never> {
  await closeBrowser();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.stdin.on('close', () => void shutdown(0));

await server.connect(new StdioServerTransport());
