import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getBrowser } from '../src/browser.js';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixturesDir = join(root, 'test', 'fixtures');
export const fixture = (name: string) => join(fixturesDir, name);
export const fixtureUrl = (name: string) => pathToFileURL(fixture(name)).href;
export const distBuilt = existsSync(join(root, 'dist', 'cli.js')) && existsSync(join(root, 'dist', 'mcp.js'));

async function detectChromium(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch (err) {
    console.warn(
      '\n[css-lab tests] Skipping browser tests: Chromium could not be launched.\n' +
        'Install it with `npx playwright install chromium` (or `node dist/cli.js install-browser`).\n' +
        `Reason: ${(err as Error).message.split('\n')[0]}\n`,
    );
    return false;
  }
}

export const chromiumAvailable = await detectChromium();

const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

/** Serves test/fixtures on 127.0.0.1:<random>; `{{CSS_ORIGIN}}` in HTML is replaced with `cssOrigin`. */
export async function serveFixtures(cssOrigin = ''): Promise<{ origin: string; server: Server; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    if (!/^[\w.-]+$/.test(name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = await readFile(fixture(name), 'utf8');
      if (name.endsWith('.html')) body = body.replaceAll('{{CSS_ORIGIN}}', cssOrigin);
      res.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { origin: `http://127.0.0.1:${port}`, server, close: () => new Promise((r) => server.close(() => r())) };
}
