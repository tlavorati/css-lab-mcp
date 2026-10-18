import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser } from '../src/browser.js';
import { scanInvisibleBlockers } from '../src/inspect.js';
import { chromiumAvailable, fixture } from './helpers.js';

describe.skipIf(!chromiumAvailable)('scan_invisible_blockers (real Chromium)', () => {
  afterAll(closeBrowser);

  it('finds the transparent wrapper, the ::after overlay and the leftover backdrop', async () => {
    const r = await scanInvisibleBlockers(fixture('invisible-blockers.html'));
    expect(r.viewports.map((v) => v.viewport.name)).toEqual(['desktop', 'mobile']);
    for (const v of r.viewports) {
      const by = (sel: string) => v.blockers.find((b) => b.occluder.selector + (b.pseudo ?? '') === sel);
      const wrapper = by('.promo > .carousel-track');
      expect(wrapper?.coveredElements.map((c) => c.label)).toContain('button#promo-cta');
      expect(wrapper?.reasons.join(' ')).toMatch(/paints nothing/);
      expect(wrapper?.realClick?.reachedCoveredElement).toBe(false);
      expect(wrapper?.rules.some((d) => d.property === 'inset')).toBe(true);

      const pseudo = by('.tile::after');
      expect(pseudo?.pseudo).toBe('::after');
      expect(pseudo?.coveredElements.map((c) => c.label)).toContain('button#tile-action');
      expect(pseudo?.rules.some((d) => d.selector === '.tile::after' && d.property === 'position')).toBe(true);
      expect(pseudo?.fixes[0].css).toContain('.tile::after');

      const backdrop = by('.backdrop');
      expect(backdrop?.reasons.join(' ')).toMatch(/opacity: 0/);
      expect(backdrop?.coveredElements.map((c) => c.label)).toContain('a#help');
      expect(backdrop?.rules.some((d) => d.property === 'opacity' && d.value === '0')).toBe(true);

      // pointer-events:none decoration is not a blocker
      expect(v.blockers.some((b) => b.occluder.selector.includes('shine'))).toBe(false);
      expect(v.blockers).toHaveLength(3);
    }
    expect(r.found).toBe(6);
  });

  it('reports nothing on a clean page', async () => {
    const r = await scanInvisibleBlockers(fixture('card-stacking-fixed.html'), {
      viewports: ['desktop'],
      preActions: [{ type: 'click', selector: '.card:nth-child(1) .menu-toggle' }],
    });
    expect(r.found).toBe(0);
  });
});
