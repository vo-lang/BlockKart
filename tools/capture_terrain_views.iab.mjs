import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const terrainCaptureViews = [
  { id: 'panorama_45', file: 'terrain-agent-latest-panorama.png', f6Presses: 1 },
  { id: 'approach_cut', file: 'terrain-agent-latest-approach-cut.png', f6Presses: 2 },
  { id: 'inner_basin', file: 'terrain-agent-latest-inner-basin.png', f6Presses: 3 },
  { id: 'ridge_profile', file: 'terrain-agent-latest-ridge-profile.png', f6Presses: 4 },
];

const defaultOutDir = '/Users/wuhao/code/github/BlockKart/docs/images';
const defaultRunnerUrl = 'http://localhost:5174/?proj=/Users/wuhao/code/github/BlockKart&mode=runner&debug=1#/runner';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveScreenshot(tab, outDir, file) {
  const image = await tab.playwright.screenshot({ fullPage: false });
  const path = join(outDir, file);
  await writeFile(path, Buffer.from(image.toBase64(), 'base64'));
  return { image, path };
}

export async function captureTerrainViews(tab, options = {}) {
  if (!tab) {
    throw new Error('captureTerrainViews requires an initialized in-app browser tab');
  }

  const outDir = options.outDir ?? defaultOutDir;
  const runnerUrl = options.runnerUrl ?? defaultRunnerUrl;
  const cacheBust = options.cacheBust ?? true;
  const settleMs = options.settleMs ?? 4200;
  const viewSettleMs = options.viewSettleMs ?? 750;
  const click = options.click ?? { x: 730, y: 430 };

  await mkdir(outDir, { recursive: true });
  const url = cacheBust ? withCacheBust(runnerUrl) : runnerUrl;
  await tab.goto(url);
  await tab.playwright.waitForLoadState({ state: 'load', timeoutMs: 20000 });
  await sleep(settleMs);
  await tab.cua.click(click);
  await sleep(650);

  const captures = [];
  for (const view of terrainCaptureViews) {
    await tab.cua.keypress({ keys: ['F6'] });
    await sleep(viewSettleMs);
    const { image, path } = await saveScreenshot(tab, outDir, view.file);
    captures.push({ ...view, path, image });
  }

  if (typeof options.display === 'function') {
    const displayIndex = options.displayView === 'approach_cut' ? 1 : 0;
    await options.display(captures[displayIndex].image);
  }

  return captures.map(({ image, ...capture }) => capture);
}

function withCacheBust(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('terrainPass', String(Date.now()));
  return parsed.toString();
}
