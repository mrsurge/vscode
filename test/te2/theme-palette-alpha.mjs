// Isolated browser regression; never connects to a running TE2 client.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../build/node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const esm = process.env.MONACO_ESM_ROOT || path.join(root, 'out-monaco-editor-core/esm');
const built = await build({
  stdin: { contents: `import * as monaco from ${JSON.stringify(path.join(esm, 'vs/editor/editor.api.js'))}; window.monaco = monaco;`, resolveDir: root },
  bundle: true, format: 'iife', write: false, outfile: 'editor.js',
  loader: { '.css': 'empty', '.ttf': 'dataurl' },
});
const server = http.createServer((req, res) => {
  if (req.url === '/editor.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(built.outputFiles[0].contents);
  } else {
    res.setHeader('content-type', 'text/html');
    res.end('<div id="editor" style="width:400px;height:200px"></div><script src="/editor.js"></script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const cold of [true, false]) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const state = await page.evaluate(cold => {
      const { monaco } = window;
      const palette = [null, '#BFBDB6', '#0B0E14', '#ACB6BF8C', '#FF8F40', '#BFBDB605', '#FF8F40', '#BFBDB60F'];
      let editor;
      if (!cold) editor = monaco.editor.create(document.querySelector('#editor'), { value: 'keyword', automaticLayout: false });
      monaco.editor.defineTheme('alpha-theme', { base: 'vs-dark', inherit: true,
        rules: [{ token: 'keyword', foreground: 'FF8F40' }], colors: { 'editor.foreground': '#BFBDB6', 'editor.background': '#0B0E14' } });
      monaco.editor.setTheme('alpha-theme');
      monaco.languages.setColorMap(palette);
      if (cold) editor = monaco.editor.create(document.querySelector('#editor'), { value: 'keyword', theme: 'alpha-theme', automaticLayout: false });
      // Reapplication must neither throw nor collapse duplicate/alpha entries.
      monaco.languages.setColorMap(palette);
      const service = editor._themeService;
      const keywordId = (service.getColorTheme().tokenTheme.match(1, 'keyword') >>> 15) & 511;
      const css = document.querySelector('style.monaco-colors').textContent;
      return { keywordId, keywordRule: css.match(/\.mtk4[^}]+}/)?.[0],
        alphaRule: css.match(/\.mtk3[^}]+}/)?.[0], paletteLength: service.getColorTheme().tokenTheme.getColorMap().length };
    }, cold);
    assert.equal(state.keywordId, 4);
    assert.match(state.keywordRule, /#ff8f40/i);
    assert.match(state.alphaRule, /rgba\(/);
    assert.equal(state.paletteLength, 8);
    await page.close();
  }
  console.log('Cold and live alpha palettes preserve token indices and rendered CSS.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
