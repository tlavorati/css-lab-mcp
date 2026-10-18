#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { BrowserNotInstalledError, closeBrowser, parsePreAction, UserInputError } from './browser.js';
import { formatInspect, formatRules, formatScan, formatStack } from './format.js';
import { cssRulesForElement, elementStackAtPoint, inspectClickTarget, scanInvisibleBlockers } from './inspect.js';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const HELP = `${pc.bold('css-lab')} ${pkg.version} - real-browser CSS click doctor

${pc.bold('Usage')}
  css-lab inspect <url-or-file> --selector "<css>" [options]   Why can't I click this?
  css-lab scan    <url-or-file> [options]                      Find invisible elements eating clicks
  css-lab stack   <url-or-file> --x <px> --y <px> [options]    Everything under a point, top first
  css-lab rules   <url-or-file> --selector "<css>" [options]   CSS rules that apply (with source lines)
  css-lab install-browser                                      Install the matching Chromium build

${pc.bold('Options')}
  -s, --selector <css>      Target element (first match is used)
      --viewport <list>     desktop, mobile, tablet or WxH; comma-separated (default: desktop,mobile;
                            stack/rules use the first one)
      --pre <action>        Pre-action, repeatable: click:<sel> hover:<sel> focus:<sel> scroll:<sel>
                            wait:<sel> wait:<ms> press:<key>
      --screenshot <file>   PNG with the target (green) and occluder / invisible blockers (red) outlined
      --step <px>           scan: grid step in CSS pixels (default: 24)
      --x <px>, --y <px>    stack: viewport coordinates
      --properties <list>   rules: comma-separated properties (default: stacking/visibility set)
      --all                 rules: every property
      --pseudo <name>       rules: pseudo-element, e.g. ::after
      --no-real-click       inspect/scan: skip real mouse clicks (hit test only)
      --wait-until <event>  load | domcontentloaded | networkidle (default: load)
      --timeout <ms>        Navigation/action timeout (default: 30000)
      --json                Machine-readable JSON output (for AI assistants and scripts)
  -v, --verbose             Show the full element stack at the target center
  -h, --help                Show help
      --version             Show version

${pc.bold('Exit codes')}  0 = clickable / nothing found, 2 = blocked / blockers found, 1 = error

${pc.bold('Examples')}
  css-lab inspect ./page.html -s "#delete" --pre "click:.menu-toggle" --pre "wait:.menu.open"
  css-lab scan https://localhost:3000 --screenshot blockers.png
  css-lab stack ./page.html --x 640 --y 120 --json`;

function list(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UserInputError(`--${name} must be a number, got "${v}"`);
  return n;
}

function installBrowser(): number {
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  return r.status ?? 1;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      selector: { type: 'string', short: 's' },
      viewport: { type: 'string', multiple: true },
      pre: { type: 'string', multiple: true },
      screenshot: { type: 'string' },
      step: { type: 'string' },
      x: { type: 'string' },
      y: { type: 'string' },
      properties: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      pseudo: { type: 'string' },
      'no-real-click': { type: 'boolean' },
      'wait-until': { type: 'string' },
      timeout: { type: 'string' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }
  if (command === 'install-browser') return installBrowser();
  if (!['inspect', 'scan', 'stack', 'rules'].includes(command)) throw new UserInputError(`Unknown command "${command}". Run css-lab --help.`);
  if (!target) throw new UserInputError(`Missing <url-or-file>. Usage: css-lab ${command} <url-or-file> ...`);

  const waitUntil = values['wait-until'] as 'load' | 'domcontentloaded' | 'networkidle' | undefined;
  if (waitUntil && !['load', 'domcontentloaded', 'networkidle'].includes(waitUntil)) throw new UserInputError('--wait-until must be load, domcontentloaded or networkidle');
  const pageOpts = {
    preActions: (values.pre ?? []).map(parsePreAction),
    waitUntil,
    timeoutMs: num(values.timeout, 'timeout'),
  };
  const viewports = list(values.viewport);
  const json = !!values.json;
  const print = (obj: unknown, human: () => string) => console.log(json ? JSON.stringify(obj, null, 2) : human());

  switch (command) {
    case 'inspect': {
      if (!values.selector) throw new UserInputError('inspect requires --selector "<css>"');
      const r = await inspectClickTarget(target, values.selector, { ...pageOpts, viewports, screenshot: values.screenshot, noRealClick: values['no-real-click'] });
      print(r, () => formatInspect(r, !!values.verbose));
      return r.verdict === 'OK' ? 0 : 2;
    }
    case 'scan': {
      const r = await scanInvisibleBlockers(target, { ...pageOpts, viewports, step: num(values.step, 'step'), screenshot: values.screenshot, noRealClick: values['no-real-click'] });
      print(r, () => formatScan(r));
      return r.found ? 2 : 0;
    }
    case 'stack': {
      const x = num(values.x, 'x');
      const y = num(values.y, 'y');
      if (x === undefined || y === undefined) throw new UserInputError('stack requires --x and --y');
      const r = await elementStackAtPoint(target, x, y, { ...pageOpts, viewport: viewports?.[0] });
      print(r, () => formatStack(r));
      return 0;
    }
    case 'rules': {
      if (!values.selector) throw new UserInputError('rules requires --selector "<css>"');
      const r = await cssRulesForElement(target, values.selector, {
        ...pageOpts,
        viewport: viewports?.[0],
        properties: values.all ? 'all' : list(values.properties),
        pseudo: values.pseudo,
      });
      print(r, () => formatRules(r));
      return r.element ? 0 : 2;
    }
  }
  return 1;
}

main(process.argv.slice(2))
  .then(async (code) => {
    await closeBrowser();
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    await closeBrowser();
    if (err instanceof BrowserNotInstalledError || err instanceof UserInputError) {
      console.error(pc.red(err.message));
    } else if (err instanceof TypeError && /parseArgs|Unknown option|ERR_PARSE_ARGS/.test(String((err as { code?: string }).code ?? err.message))) {
      console.error(pc.red(err.message));
    } else {
      console.error(pc.red(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    }
    process.exitCode = 1;
  });
