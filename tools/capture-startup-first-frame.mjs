import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require('../integrations/openshop/node_modules/playwright');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = join(repoRoot, 'desktop', 'Hstar.Desktop', 'Assets', 'startup');
const output = join(assetRoot, 'startup-first-frame.png');
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = resolve(assetRoot, `.${relative}`);
    if (!file.startsWith(assetRoot + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(extname(file)) || 'application/octet-stream',
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end('Not found');
  }
});

async function closeServer(serverToClose) {
  if (!serverToClose.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    serverToClose.close(error => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

let browser;
try {
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const address = server.address();
  browser = await chromium.launch({headless: true});
  const page = await browser.newPage({
    viewport: {width: 1920, height: 1080},
    deviceScaleFactor: 2,
  });
  await page.addInitScript(() => {
    window.__hstarStartupVisualReady = false;
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        webview: {
          postMessage(message) {
            if (message?.type === 'hstar-startup:visual-ready') {
              window.__hstarStartupVisualReady = true;
            }
          },
        },
      },
    });
  });
  await page.goto(`http://127.0.0.1:${address.port}/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__hstarStartupVisualReady === true,
    undefined,
    {timeout: 15_000},
  );
  await page.evaluate(async () => {
    await (document.fonts?.ready ?? Promise.resolve());
    await Promise.all(Array.from(document.images, image => image.decode().catch(() => {})));
    await new Promise(resolveFrame => {
      requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
    });

    document
      .querySelector('.startup-title-art g rect:not(.startup-title-highlight)')
      ?.setAttribute('fill', '#ffffff');
    document
      .querySelector('.startup-title-highlight')
      ?.setAttribute('display', 'none');
  });
  await page.screenshot({path: output, type: 'png', fullPage: false});
  console.log(output);
} finally {
  if (browser) await browser.close();
  await closeServer(server);
}
