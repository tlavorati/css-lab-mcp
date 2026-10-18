import { describe, expect, it } from 'vitest';
import { parsePreAction, parseViewport, resolveTarget, UserInputError } from '../src/browser.js';
import { formatSource } from '../src/rules.js';
import { fixture } from './helpers.js';

describe('argument parsing', () => {
  it('parses pre-actions', () => {
    expect(parsePreAction('click:.menu-toggle')).toEqual({ type: 'click', selector: '.menu-toggle' });
    expect(parsePreAction('wait:.menu.open')).toEqual({ type: 'wait', selector: '.menu.open' });
    expect(parsePreAction('wait:250')).toEqual({ type: 'wait', ms: 250 });
    expect(parsePreAction('press:Escape')).toEqual({ type: 'press', key: 'Escape' });
    expect(parsePreAction('hover:a[href="x:y"]')).toEqual({ type: 'hover', selector: 'a[href="x:y"]' });
    expect(() => parsePreAction('tap:.x')).toThrow(UserInputError);
    expect(() => parsePreAction('click')).toThrow(UserInputError);
  });

  it('parses viewports', () => {
    expect(parseViewport('desktop')).toMatchObject({ width: 1280, height: 900, isMobile: false });
    expect(parseViewport('mobile')).toMatchObject({ width: 390, height: 844, isMobile: true });
    expect(parseViewport('1024x768')).toMatchObject({ width: 1024, height: 768 });
    expect(() => parseViewport('huge')).toThrow(UserInputError);
  });

  it('resolves URLs and file paths', () => {
    expect(resolveTarget('https://example.com/a')).toBe('https://example.com/a');
    expect(resolveTarget(fixture('clipped.html'))).toMatch(/^file:\/\/.*clipped\.html$/);
    expect(() => resolveTarget('does-not-exist.html')).toThrow(UserInputError);
  });

  it('formats rule sources', () => {
    expect(formatSource({ source: 'http://localhost:3000/assets/cards.css', line: 9, inline: false })).toBe('cards.css:9');
    expect(formatSource({ source: 'file:///tmp/page.html', line: 12, inline: true })).toBe('page.html:12 (<style>)');
    expect(formatSource({ source: 'style attribute', line: null, inline: true })).toBe('style attribute');
  });
});
