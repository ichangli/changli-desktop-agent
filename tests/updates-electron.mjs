import { _electron as electron, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir = mkdtempSync(join(tmpdir(), 'changli-updates-e2e-')), launcher = join(dir, 'launch.cjs')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
writeFileSync(launcher, `const electron = require('electron');
global.__updateRequests = []; global.__openedUrls = []; global.__updateStatus = 200;
global.__updateRelease = [{ tag_name: 'v9.0.0-beta.1', draft: false, prerelease: true, body: '新版说明 <script>window.UPDATE_INJECTED=true</script>', assets: [{name:'fixture.exe',state:'uploaded'}], html_url: 'https://evil.example' }];
electron.net.fetch = async (url, options) => { global.__updateRequests.push({url, options}); return new Response(JSON.stringify(global.__updateRelease), {status: global.__updateStatus}); };
electron.shell.openExternal = async url => { global.__openedUrls.push(url); };
import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)});`)
const env = { ...process.env, CHANGLI_DATA_DIR: join(dir, 'data') }; delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [launcher], env })
  const page = await app.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: '版本更新', exact: false }).click()
  expect(await app.evaluate(() => global.__updateRequests.length)).toBe(0)
  await expect(page.locator('.settings-panel')).toContainText(version)
  await page.getByRole('button', { name: '前往 GitHub 下载', exact: true }).click()
  expect(await app.evaluate(() => global.__openedUrls)).toEqual(['https://github.com/ichangli/changli-desktop-agent/releases'])
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('发现新版本')
  await expect(page.locator('.record pre')).toContainText('<script>')
  expect(await page.evaluate(() => window.UPDATE_INJECTED)).toBeUndefined()
  await page.getByRole('button', { name: '前往 GitHub 下载', exact: true }).click()
  expect(await app.evaluate(() => global.__openedUrls.at(-1))).toBe('https://github.com/ichangli/changli-desktop-agent/releases/tag/v9.0.0-beta.1')
  await app.evaluate(() => { global.__updateRelease[0].tag_name = 'v0.1.0' })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('当前版本不低于')
  await app.evaluate(() => { global.__updateStatus = 403 })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('限制了请求')
  await expect(page.locator('.record')).toHaveCount(0)
  await app.evaluate(() => { global.__updateStatus = 200; global.__updateRelease = [] })
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('暂未找到')
  mkdirSync('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/updates.png' })
  expect(errors).toEqual([])
  console.log('更新页 Electron 回归通过：不自动联网、检查/新版本/本地较新/限流/空列表/纯文本说明/固定下载地址。网络与浏览器为桩。')
} finally {
  await app?.close().catch(() => {})
  if (!dir.startsWith(join(tmpdir(), 'changli-updates-e2e-'))) throw new Error('临时目录越界')
  rmSync(dir, { recursive: true, force: true })
}
