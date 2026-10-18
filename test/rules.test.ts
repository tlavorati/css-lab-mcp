import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeBrowser, openPage, VIEWPORTS } from '../src/browser.js';
import { cssRulesForElement, inspectClickTarget } from '../src/inspect.js';
import type { PreAction } from '../src/types.js';
import { chromiumAvailable, fixture, fixtureUrl, serveFixtures } from './helpers.js';

const openFirstMenu: PreAction[] = [{ type: 'click', selector: '.card:nth-child(1) .menu-toggle' }];

describe.skipIf(!chromiumAvailable)('CSS rule attribution via CDP', () => {
  let pageSrv: Awaited<ReturnType<typeof serveFixtures>>;
  let cssSrv: Awaited<ReturnType<typeof serveFixtures>>;

  beforeAll(async () => {
    // Two servers = two origins: the page and its stylesheet are cross-origin.
    cssSrv = await serveFixtures();
    pageSrv = await serveFixtures(cssSrv.origin.replace('127.0.0.1', 'localhost'));
  });
  afterAll(async () => {
    await closeBrowser();
    await pageSrv?.close();
    await cssSrv?.close();
  });

  it('attributes rules from a cross-origin stylesheet (CSSOM cannot read it)', async () => {
    const url = `${pageSrv.origin}/card-stacking-xorigin.html`;
    // Sanity check: the page itself cannot read the stylesheet's rules.
    const { page, close } = await openPage(url, VIEWPORTS.desktop);
    const blocked = await page.evaluate(() => {
      const sheet = [...document.styleSheets].find((s) => s.href?.includes('cards.css'));
      try {
        void sheet?.cssRules;
        return false;
      } catch {
        return true;
      }
    });
    await close();
    expect(blocked).toBe(true);

    const r = await cssRulesForElement(url, '.card-header', { properties: ['position', 'z-index'] });
    expect(r.method).toBe('cdp');
    const z = r.rules.find((d) => d.property === 'z-index');
    expect(z).toMatchObject({ selector: '.card > *', value: '1', line: 9, winning: true, inline: false });
    expect(z?.source).toMatch(/^http:\/\/localhost:\d+\/cards\.css$/);

    const inspect = await inspectClickTarget(url, '.card:nth-child(1) .menu-item.danger', { viewports: ['desktop'], preActions: openFirstMenu });
    expect(inspect.verdict).toBe('COVERED_BY_SIBLING_STACKING_CONTEXT');
    expect(inspect.viewports[0].responsibleRules.find((d) => d.property === 'z-index' && d.selector === '.card > *')?.source).toContain('localhost');
  });

  it('attributes rules on file:// pages, including inline <style> line numbers', async () => {
    const ext = await cssRulesForElement(fixture('card-stacking-fixed.html'), '.card-header', { preActions: openFirstMenu, properties: ['z-index'] });
    const winner = ext.rules.find((d) => d.winning);
    expect(winner).toMatchObject({ selector: '.card > .card-header:has(.menu.open)', value: '2', inline: true, line: 10 });
    expect(winner?.source.startsWith('file://')).toBe(true);
    const loser = ext.rules.find((d) => d.selector === '.card > *');
    expect(loser).toMatchObject({ winning: false, line: 9 });
    expect(fixtureUrl('x.html').startsWith('file://')).toBe(true);
  });

  it('reads pseudo-element rules', async () => {
    const r = await cssRulesForElement(fixture('invisible-blockers.html'), '.tile', { pseudo: '::after', properties: ['content', 'position', 'inset'] });
    expect(r.rules.map((d) => d.property).sort()).toEqual(['content', 'inset', 'position']);
    expect(r.rules.every((d) => d.pseudo === '::after')).toBe(true);
  });
});
