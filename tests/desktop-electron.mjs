import { _electron as electron, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const dir = mkdtempSync(join(tmpdir(), 'changli-tray-e2e-'))
const launcher = join(dir, 'launch.cjs')
const entry = pathToFileURL(resolve('out/main/index.js')).href
// 仅测试入口记录真实 Tray/Menu；不在产品中暴露测试后门。
// 在 Electron 子进程中需要内置 electron，不能使用 npm 包的路径字符串入口。
writeFileSync(launcher, `const electron = require('electron');
const originalMenu = electron.Tray.prototype.setContextMenu;
electron.Tray.prototype.setContextMenu = function(menu) {
  global.__tray = this; global.__trayMenu = menu;
  if (process.env.CHANGLI_TEST_TRAY_FAILURE) throw new Error('fixture');
  return originalMenu.call(this, menu);
};
import(${JSON.stringify(entry)});
`)
const env = { ...process.env, CHANGLI_DATA_DIR: join(dir, 'data') }
delete env.ELECTRON_RUN_AS_NODE
let app
const issues = []
async function launch(fail = false) {
  app = await electron.launch({ args: [launcher], env: { ...env, ...(fail ? { CHANGLI_TEST_TRAY_FAILURE: '1' } : {}) } })
  const page = await app.firstWindow(); page.on('pageerror', error => issues.push(error.message))
  await page.getByRole('button', { name: '＋ 新的对话' }).waitFor()
  return page
}
const api = (page, method, value) => page.evaluate(({ method, value }) => window.changli[method](value), { method, value })
const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
const trayMenu = label => app.evaluate((_electron, label) => { const item = global.__trayMenu.items.find(item => item.label === label); item.click() }, label)
async function closeWindow() { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()) }
async function waitExit(trigger) {
  const closed = app.waitForEvent('close')
  await trigger()
  await closed
}
try {
  let page = await launch()
  expect(await api(page, 'desktopPreferences')).toEqual({ closeAction: 'quit', trayAvailable: true })
  expect(await app.evaluate(() => global.__tray.isDestroyed())).toBe(false)
  expect(await app.evaluate(() => global.__trayMenu.items.map(i => i.label))).toEqual(['显示窗口', '隐藏到托盘', '', '退出长离'])
  await expect(api(page, 'saveDesktopPreferences', { closeAction: 'bad' })).rejects.toThrow(/行为无效/)
  await page.getByRole('button', { name: '桌面设置', exact: false }).click()
  await page.getByLabel('关闭窗口时', { exact: true }).selectOption('tray')
  await page.getByRole('button', { name: '保存桌面设置', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('桌面设置已保存。')
  await page.getByRole('button', { name: '隐藏到托盘', exact: true }).click()
  await expect.poll(visible).toBe(false)
  await app.evaluate(() => global.__tray.emit('click'))
  await expect.poll(visible).toBe(true)
  await page.locator('nav button').first().click()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('后台回复测试（虚构内容）')
  await page.getByRole('button', { name: '发送 ↑' }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await closeWindow(); await expect.poll(visible).toBe(false)
  await expect.poll(async () => (await api(page, 'snapshot')).messages.at(-1).status, { timeout: 15000 }).toBe('complete')
  const selected = (await api(page, 'snapshot')).selectedId
  // 实际启动同数据目录的第二个进程，由单实例锁唤回原窗口。
  const second = spawn(resolve('node_modules/electron/dist/electron.exe'), [launcher], { env, windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { second.once('exit', code => code === 0 ? resolve() : reject(new Error('second instance exit ' + code))); second.once('error', reject) })
  await expect.poll(visible).toBe(true)
  expect((await api(page, 'snapshot')).selectedId).toBe(selected)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await trayMenu('显示窗口')
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false)
  await trayMenu('隐藏到托盘'); await expect.poll(visible).toBe(false)
  await app.evaluate(() => global.__tray.emit('double-click')); await expect.poll(visible).toBe(true)
  await page.getByRole('button', { name: '桌面设置', exact: false }).click()
  mkdirSync('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/desktop-settings.png' })
  // 关闭到托盘模式下，托盘退出仍须实际结束进程。
  await waitExit(() => trayMenu('退出长离'))
  page = await launch()
  expect(await api(page, 'desktopPreferences')).toEqual({ closeAction: 'tray', trayAvailable: true })
  expect((await api(page, 'snapshot')).messages.at(-1).status).toBe('complete')
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('退出时中断（虚构内容）')
  await page.getByRole('button', { name: '发送 ↑' }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '桌面设置', exact: false }).click()
  await page.getByRole('button', { name: '退出程序', exact: true }).click()
  await page.getByRole('button', { name: '继续使用', exact: true }).click()
  expect(await visible()).toBe(true)
  await page.getByRole('button', { name: '退出程序', exact: true }).click()
  await waitExit(() => page.getByRole('button', { name: '确认退出程序', exact: true }).click())
  page = await launch(true)
  expect(await api(page, 'desktopPreferences')).toEqual({ closeAction: 'tray', trayAvailable: false })
  expect((await api(page, 'snapshot')).messages.at(-1).status).toBe('interrupted')
  await expect(api(page, 'hideWindow')).rejects.toThrow(/托盘不可用/)
  await expect(api(page, 'saveDesktopPreferences', { closeAction: 'tray' })).rejects.toThrow(/托盘不可用/)
  expect(await visible()).toBe(true)
  await page.getByRole('button', { name: '桌面设置', exact: false }).click()
  await expect(page.getByRole('status')).toContainText('系统托盘当前不可用')
  await expect(page.getByRole('button', { name: '隐藏到托盘', exact: true })).toBeDisabled()
  await waitExit(closeWindow)
  page = await launch()
  await api(page, 'saveDesktopPreferences', { closeAction: 'quit' })
  await waitExit(closeWindow)
  page = await launch()
  expect((await api(page, 'desktopPreferences')).closeAction).toBe('quit')
  await waitExit(() => app.evaluate(({ app }) => app.quit()))
  expect(issues).toEqual([])
  console.log('托盘 Electron 回归通过：真实 Tray/Menu、设置持久化、隐藏后台生成、单实例唤回、菜单/图标恢复、托盘/界面/app.quit 退出、中断恢复、托盘失败降级。使用临时数据和测试入口记录对象。')
} finally {
  await app?.close().catch(() => {})
  if (!dir.startsWith(join(tmpdir(), 'changli-tray-e2e-'))) throw new Error('临时目录越界')
  rmSync(dir, { recursive: true, force: true })
}
