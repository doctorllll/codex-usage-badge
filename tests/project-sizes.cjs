const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { installProjectSizes, ProjectSizeScanner, measureDirectory, measureDirectoryPortable, refreshProjectSizes } = require('../agent.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'badge-project-sizes-'));
process.env.CODEX_BADGE_SIZE_ROOTS = temp;
const firstRoot = path.join(temp, '项目 A');
const secondRoot = path.join(temp, 'project-b');
fs.mkdirSync(path.join(firstRoot, 'nested'), { recursive: true });
fs.mkdirSync(secondRoot, { recursive: true });
fs.writeFileSync(path.join(firstRoot, 'nested', 'file.bin'), Buffer.alloc(2048, 1));

const ids = ['project-a', 'project-b', 'remote-project'];
const makeRow = (id, label, kind = 'local') => `<div class="row" data-app-action-sidebar-project-row data-app-action-sidebar-project-id="${id}" data-app-action-sidebar-project-label="${label}" aria-labelledby="label-${id}" role="button" tabindex="0"><span class="icon"><span data-sidebar-project-kind="${kind}"></span></span><div class="content"><span id="label-${id}" class="label">${label}</span><span class="trailing"></span></div><button aria-haspopup="menu">…</button></div>`;
const fixture = `<!doctype html><html class="dark"><meta charset="UTF-8"><style>
body{margin:0;background:#1e2021;color:#e5e7e8;font:14px -apple-system,sans-serif}.sidebar{padding:16px;width:310px}.row{height:34px;display:flex;align-items:center;gap:7px;padding:0 8px;border-radius:8px}.content{display:flex;min-width:0;flex:1;align-items:center;gap:6px}.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.trailing{display:flex;flex:none}.row button{border:0;background:none;color:inherit}input{margin-top:20px}
</style><div class="sidebar">${makeRow(ids[0], '通用')}${makeRow(ids[1], '空项目')}${makeRow(ids[2], '远程项目', 'remote')}<input id="editor" value="继续编辑"></div><script>window.rowClicks=0;document.querySelectorAll('.row').forEach(row=>row.addEventListener('click',()=>window.rowClicks++));</script></html>`;

(async () => {
  const measured = await measureDirectory(firstRoot, { timeoutMs: 10000 });
  assert.ok(measured >= 2048, 'real directory measurement must include the test file');
  assert.equal(await measureDirectoryPortable(firstRoot), 2048, 'portable measurement reads file metadata');
  await assert.rejects(measureDirectory(path.join(temp, 'missing')), /./, 'missing directory is not zero bytes');
  await assert.rejects(measureDirectory(os.homedir()), /允许目录/, 'home and other roots outside the allowlist are never walked');
  fs.symlinkSync(os.homedir(), path.join(temp, 'escape'));
  await assert.rejects(measureDirectory(path.join(temp, 'escape')), /允许目录/, 'a symlink cannot escape the allowlist');
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(measureDirectory(firstRoot, {signal: canceled.signal}));
  await assert.rejects(measureDirectoryPortable(firstRoot, {signal: canceled.signal}));

  let now = 1000, active = 0, maxActive = 0, calls = 0;
  const scanner = new ProjectSizeScanner({ cacheTtlMs: 1000, concurrency: 1, now: () => now, measure: async roots => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (roots[0] === secondRoot) throw new Error('没有访问权限');
    return 1536;
  } });
  let snap = scanner.snapshot([{ id: ids[0], roots: [firstRoot] }, { id: ids[1], roots: [secondRoot] }, { id: 'bad', roots: ['relative/path'] }]);
  assert.equal(snap.sizes[ids[0]].state, 'pending');
  assert.equal(snap.sizes.bad.state, 'unavailable');
  await scanner.whenIdle();
  snap = scanner.snapshot([{ id: ids[0], roots: [firstRoot] }, { id: ids[1], roots: [secondRoot] }]);
  assert.equal(snap.sizes[ids[0]].bytes, 1536);
  assert.equal(snap.sizes[ids[1]].state, 'error');
  assert.equal(maxActive, 1, 'scanner must honor its concurrency limit');
  assert.equal(calls, 2);
  scanner.snapshot([{ id: ids[0], roots: [firstRoot] }]);
  assert.equal(calls, 2, 'fresh cache must avoid rescanning');
  now = 2500; scanner.snapshot([{ id: ids[0], roots: [firstRoot] }]); await scanner.whenIdle();
  assert.equal(calls, 3, 'stale cache must refresh');

  // A malformed measurement becomes an isolated error, never an unhandled
  // rejection that terminates the agent and removes every sidebar feature.
  const invalid = new ProjectSizeScanner({measure: async () => NaN});
  invalid.snapshot([{id: ids[0], roots: [firstRoot]}]); await invalid.whenIdle();
  assert.equal(invalid.snapshot([{id: ids[0], roots: [firstRoot]}]).sizes[ids[0]].state, 'error');
  invalid.stop();
  let aborted = false, started;
  const begun = new Promise(resolve => { started = resolve; });
  const cancelable = new ProjectSizeScanner({concurrency: 1, measure: (roots, {signal}) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); }, {once: true});
  })});
  cancelable.snapshot([{id: ids[0], roots: [firstRoot]}, {id: ids[1], roots: [secondRoot]}]);
  await begun; cancelable.stop(); await cancelable.whenIdle();
  assert.equal(aborted, true); assert.equal(cancelable.cache.size, 0, 'stopped measurements cannot update the cache');
  assert.equal(cancelable.queue.length, 0);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 240 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(fixture);
    await page.evaluate(({ ids, firstRoot }) => {
      window.electronBridge = { getInitialSidebarBootstrap: async () => ({ globalStateEntries: [{ key: 'local-projects', value: {
        [ids[0]]: { id: ids[0], rootPaths: [firstRoot] }, [ids[1]]: { id: ids[1], rootPaths: [] }
      } }] }) };
    }, { ids, firstRoot });
    await page.locator('#editor').focus();
    const heights = await page.locator('.row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    await page.evaluate(`(${installProjectSizes.toString()})()`);
    assert.equal(await page.locator('#editor').evaluate(el => el === document.activeElement), true, 'injection must preserve input focus');
    assert.deepEqual(await page.evaluate(() => window.__codexProjectSizes.requestedProjects()), [
      { id: ids[0], roots: [firstRoot] }, { id: ids[1], roots: [] }
    ]);
    assert.equal(await page.locator('[data-codex-project-size]').count(), 2, 'remote projects must not get local size badges');
    assert.deepEqual(await page.locator('[data-codex-project-size]').allTextContents(), ['…', '…']);

    const uiScanner = new ProjectSizeScanner({ measure: async () => 1536 });
    const session = { evaluate: async expression => ({ result: { value: await page.evaluate(expression) } }) };
    const injector = { sessions: new Map([['test', session]]) };
    await refreshProjectSizes(injector, uiScanner);
    await uiScanner.whenIdle();
    await refreshProjectSizes(injector, uiScanner);
    assert.deepEqual(await page.locator('[data-codex-project-size]').allTextContents(), ['1.5 KB', '—']);
    const messages = new Map();
    const scopedScanner = new ProjectSizeScanner({measure: async () => 1024});
    const fakeSession = (key, projects) => ({evaluate: async expression => {
      if (expression.includes('requestedProjects')) return {result: {value: projects}};
      const payload = expression.slice(expression.indexOf('update(') + 7, -1);
      messages.set(key, JSON.parse(payload));
    }});
    await refreshProjectSizes({sessions: new Map([
      ['first', fakeSession('first', [{id: ids[0], roots: [firstRoot]}])],
      ['second', fakeSession('second', [{id: ids[1], roots: [secondRoot]}])],
      ['offline', {evaluate: async () => {throw Error('disconnected');}}]
    ])}, scopedScanner);
    assert.deepEqual(Object.keys(messages.get('first').sizes), [ids[0]]);
    assert.deepEqual(Object.keys(messages.get('second').sizes), [ids[1]]);
    assert(!JSON.stringify(messages.get('first')).includes(secondRoot), 'another window must not receive unrelated roots');
    await scopedScanner.whenIdle(); scopedScanner.stop();
    assert.match(await page.locator('[data-codex-project-size]').first().getAttribute('title'), /项目大小：1\.5 KB/);
    assert.match(await page.locator('[data-codex-project-size]').first().getAttribute('title'), new RegExp(firstRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await page.locator('.label').first().textContent(), '通用', 'project label text must remain untouched');
    assert.deepEqual(await page.locator('.row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height)), heights);
    assert.equal(await page.locator('[data-codex-project-size]').first().evaluate(el => el.parentElement.classList.contains('trailing')), true, 'size belongs in the native trailing slot');
    await page.locator('[data-codex-project-size]').first().click();
    assert.equal(await page.evaluate(() => window.rowClicks), 1, 'badge must not block the project row click');

    await page.locator('.row').first().evaluate(row => row.replaceWith(row.cloneNode(true)));
    await page.waitForFunction(() => window.__codexProjectSizes.status().badges === 2);
    assert.equal(await page.locator('[data-codex-project-size]').count(), 2, 'row remount must not duplicate badges');
    await page.locator('.row').first().locator('[data-sidebar-project-kind]').evaluate(el => el.setAttribute('data-sidebar-project-kind', 'remote'));
    await page.waitForFunction(() => document.querySelectorAll('[data-codex-project-size]').length === 1);
    await page.locator('.row').first().locator('[data-sidebar-project-kind]').evaluate(el => el.setAttribute('data-sidebar-project-kind', 'local'));
    await page.waitForFunction(() => document.querySelectorAll('[data-codex-project-size]').length === 2);
    for (let i = 0; i < 3; i++) await page.evaluate(`(${installProjectSizes.toString()})()`);
    assert.equal(await page.locator('#codex-project-sizes-style').count(), 1);
    assert.equal(await page.locator('[data-codex-project-size]').count(), 2);
    await page.locator('.row').first().locator('.trailing').evaluate(el => el.remove());
    await page.waitForSelector('[data-codex-project-size-slot] [data-codex-project-size]');
    await page.screenshot({ path: path.join(__dirname, 'preview-project-sizes.png') });
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.__codexProjectSizes.destroy());
    assert.equal(await page.locator('[data-codex-project-size],[data-codex-project-size-slot],#codex-project-sizes-style').count(), 0);
    uiScanner.stop();
  } finally { await browser.close(); }
  scanner.stop();
  console.log('PASS read-only folder measurement, path validation, bounded concurrency, cache refresh, error isolation, native trailing-slot rendering, formatting, remount/idempotency, click propagation, focus preservation and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(temp, { recursive: true, force: true }));
