import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser } from '../src/browser.js';
import { inspectClickTarget } from '../src/inspect.js';
import type { PreAction } from '../src/types.js';
import { chromiumAvailable, fixture } from './helpers.js';

const openFirstMenu: PreAction[] = [
  { type: 'click', selector: '.card:nth-child(1) .menu-toggle' },
  { type: 'wait', selector: '.card:nth-child(1) .menu.open' },
];
const DELETE = '.card:nth-child(1) .menu-item.danger';

describe.skipIf(!chromiumAvailable)('inspect_click_target (real Chromium)', () => {
  afterAll(closeBrowser);

  it('detects the card dropdown trapped in a sibling stacking context', async () => {
    const r = await inspectClickTarget(fixture('card-stacking-bug.html'), DELETE, { preActions: openFirstMenu });
    expect(r.verdict).toBe('COVERED_BY_SIBLING_STACKING_CONTEXT');
    expect(r.clickable).toBe(false);
    for (const d of r.viewports) {
      expect(d.verdict).toBe('COVERED_BY_SIBLING_STACKING_CONTEXT');
      // Hit test evidence: the real click lands on the next card, not on "Delete".
      expect(d.probes[0].realClick?.reachedTarget).toBe(false);
      expect(d.probes[0].realClick?.receivedBy).toMatch(/card-(header|body)/);
      // Stacking analysis: both layers are direct children of a card, in the root context.
      expect(d.stacking?.trapped).toBe(true);
      expect(d.stacking?.commonAncestor.label).toBe('html');
      expect(d.stacking?.targetBranch.label).toMatch(/^header\.card-header\[1\/3\]/);
      expect(d.stacking?.occluderBranch.label).toMatch(/\[2\/3\]/);
      // The broad rule is identified, with its source line.
      const z = d.responsibleRules.find((x) => x.selector === '.card > *' && x.property === 'z-index');
      expect(z).toBeDefined();
      expect(z?.value).toBe('1');
      expect(z?.source).toMatch(/cards\.css$/);
      expect(z?.line).toBe(9);
      // The fix targets the card's direct child that contains the open menu, not a global z-index.
      expect(d.fixes[0].css).toContain('.card > .card-header:has(.menu.open)');
      expect(d.fixes[0].css).toContain('z-index: 2');
      expect(d.fixes.map((f) => f.description).join(' ')).toContain('`.card > *`');
      expect(d.warnings.join(' ')).toMatch(/will not help/);
    }
  });

  it('reports OK once the fix is applied', async () => {
    const r = await inspectClickTarget(fixture('card-stacking-fixed.html'), DELETE, { preActions: openFirstMenu });
    expect(r.verdict).toBe('OK');
    expect(r.clickable).toBe(true);
    for (const d of r.viewports) expect(d.probes.every((p) => p.realClick?.reachedTarget)).toBe(true);
  });

  it('treats a pointer-events:none overlay as click-through (OK with a warning)', async () => {
    const r = await inspectClickTarget(fixture('pointer-events.html'), '#cta', { viewports: ['desktop'] });
    expect(r.verdict).toBe('OK');
    expect(r.viewports[0].warnings.join(' ')).toMatch(/hero-shine.*pointer-events: none/);
  });

  it('detects pointer-events:none inherited from an ancestor', async () => {
    const r = await inspectClickTarget(fixture('pointer-events.html'), '#save', { viewports: ['desktop'] });
    expect(r.verdict).toBe('POINTER_EVENTS_NONE');
    const d = r.viewports[0];
    expect(d.responsibleRules[0]).toMatchObject({ selector: '.locked', property: 'pointer-events', value: 'none' });
    expect(d.fixes[0].css).toContain('#save');
    expect(d.fixes[0].css).toContain('pointer-events: auto');
  });

  it('flags a transparent fixed backdrop as an invisible occluder', async () => {
    const r = await inspectClickTarget(fixture('fixed-overlay.html'), '#buy');
    expect(r.verdict).toBe('INVISIBLE_OCCLUDER');
    const d = r.viewports[0];
    expect(d.occluder?.label).toBe('div.modal-backdrop');
    expect(d.occluder?.invisible.invisible).toBe(true);
    expect(d.occluder?.invisible.reasons.join(' ')).toMatch(/opacity: 0/);
    expect(d.responsibleRules.some((x) => x.selector === '.modal-backdrop' && x.property === 'opacity' && x.value === '0')).toBe(true);
    expect(d.fixes.some((f) => f.css?.includes('.modal-backdrop') && f.css.includes('pointer-events: none'))).toBe(true);
  });

  it('reports a visible fixed header as COVERED_BY_POSITIONED_ELEMENT', async () => {
    const r = await inspectClickTarget(fixture('sticky-header.html'), '#under', { viewports: ['desktop'] });
    expect(r.verdict).toBe('COVERED_BY_POSITIONED_ELEMENT');
    expect(r.viewports[0].occluder?.invisible.invisible).toBe(false);
    expect(r.viewports[0].fixes[0].css).toContain('z-index: 11');
  });

  it('detects an element clipped by overflow:hidden', async () => {
    const r = await inspectClickTarget(fixture('clipped.html'), '#more', { viewports: ['desktop'] });
    expect(r.verdict).toBe('OUTSIDE_VIEWPORT_OR_CLIPPED');
    const d = r.viewports[0];
    expect(d.summary).toContain('div.panel');
    expect(d.responsibleRules.some((x) => x.selector === '.panel' && x.property === 'overflow' && x.value === 'hidden')).toBe(true);
    expect(d.fixes[0].css).toContain('overflow: visible');
  });

  it('detects display:none, visibility:hidden, zero size and missing elements', async () => {
    const opts = { viewports: ['desktop'] };
    const none = await inspectClickTarget(fixture('hidden.html'), '#in-collapsed', opts);
    expect(none.verdict).toBe('INVISIBLE');
    expect(none.viewports[0].responsibleRules[0]).toMatchObject({ selector: '.collapsed', property: 'display' });
    const ghost = await inspectClickTarget(fixture('hidden.html'), '#in-ghost', opts);
    expect(ghost.verdict).toBe('INVISIBLE');
    expect(ghost.viewports[0].responsibleRules[0]).toMatchObject({ selector: '.ghost', property: 'visibility' });
    expect((await inspectClickTarget(fixture('hidden.html'), '#empty', opts)).verdict).toBe('ZERO_SIZE');
    expect((await inspectClickTarget(fixture('hidden.html'), '#missing', opts)).verdict).toBe('NOT_FOUND');
  });
});
