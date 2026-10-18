import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromiumAvailable, distBuilt, fixture, root } from './helpers.js';

const cli = (args: string[]) => spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), ...args], { encoding: 'utf8', timeout: 60_000 });

describe.skipIf(!chromiumAvailable || !distBuilt)('built CLI and MCP server', () => {
  it('CLI exit codes: 2 when blocked, 0 when clickable, 1 on errors', () => {
    const pre = ['--pre', 'click:.card:nth-child(1) .menu-toggle', '--viewport', 'desktop'];
    const bad = cli(['inspect', fixture('card-stacking-bug.html'), '-s', '.card:nth-child(1) .menu-item.danger', ...pre, '--json']);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout).verdict).toBe('COVERED_BY_SIBLING_STACKING_CONTEXT');
    const good = cli(['inspect', fixture('card-stacking-fixed.html'), '-s', '.card:nth-child(1) .menu-item.danger', ...pre]);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('OK');
    const err = cli(['inspect', 'nope.html', '-s', 'a']);
    expect(err.status).toBe(1);
    expect(err.stderr).toContain('Target not found');
    const scan = cli(['scan', fixture('invisible-blockers.html'), '--viewport', 'desktop', '--json']);
    expect(scan.status).toBe(2);
    expect(JSON.parse(scan.stdout).found).toBe(3);
  });

  it('MCP server exposes the tools and answers over stdio', async () => {
    const client = new Client({ name: 'css-lab-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'mcp.js')], stderr: 'pipe' }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['css_rules_for_element', 'element_stack_at_point', 'inspect_click_target', 'scan_invisible_blockers']);
      const res = await client.callTool({
        name: 'inspect_click_target',
        arguments: { target: fixture('fixed-overlay.html'), selector: '#buy', viewports: ['desktop'] },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text).verdict).toBe('INVISIBLE_OCCLUDER');
      const stack = await client.callTool({ name: 'element_stack_at_point', arguments: { target: fixture('fixed-overlay.html'), x: 60, y: 120 } });
      const els = JSON.parse((stack.content as Array<{ text: string }>)[0].text).elements;
      expect(els[0]).toMatchObject({ label: 'div.modal-backdrop', visuallyInvisible: true });
      const err = await client.callTool({ name: 'inspect_click_target', arguments: { target: 'missing.html', selector: 'a' } });
      expect(err.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
