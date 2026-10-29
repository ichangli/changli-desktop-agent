import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const executablePath = resolve(process.argv[2] || join(root, `release/changli-desktop-agent-${version}-win-x64-portable.exe`))
if (!existsSync(executablePath)) throw new Error('未找到单文件便携版，请先运行 npm run dist:win，或传入便携版 .exe 路径。')

const directory = mkdtempSync(join(tmpdir(), 'changli-portable-'))
const listener = createServer()
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const env = { ...process.env, CHANGLI_DATA_DIR: directory }
delete env.ELECTRON_RUN_AS_NODE
const wrapper = spawn(executablePath, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  cwd: dirname(executablePath), env, stdio: 'ignore', windowsHide: true, shell: false
})
let exited = false, browser, page
const exit = new Promise(resolve => {
  wrapper.once('error', error => { exited = true; resolve({ error: error.message, code: null }) })
  wrapper.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
})

async function waitForExit(milliseconds) {
  return Promise.race([exit, delay(milliseconds).then(() => null)])
}

async function closeOwnWindow() {
  if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => {})
}

try {
  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90000
  while (!browser && Date.now() < deadline) {
    if (exited) throw new Error(`便携版在窗口可连接前退出：${JSON.stringify(await exit)}`)
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) browser = await chromium.connectOverCDP(endpoint, { timeout: 3000 })
    } catch { /* 包装程序首次解压和启动可能需要几秒。 */ }
    if (!browser) await delay(250)
  }
  if (!browser) throw new Error('90 秒内未能连接便携版的本机调试端口。')
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('file://'))
    if (!page) await delay(100)
  }
  if (!page) throw new Error('便携版没有打开本地应用页面。')
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => typeof window.changli?.snapshot === 'function')
  expect(page.url()).toMatch(/^file:\/\//)
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  const apiMethods = await page.evaluate(() => Object.keys(window.changli).sort())
  expect(apiMethods).toEqual(['configureApp', 'create', 'deleteMemory', 'grantApp', 'onChange', 'renameApp', 'retry', 'runTool', 'saveMemory', 'saveSettings', 'select', 'send', 'snapshot', 'stop', 'testConnection', 'workspace'].sort())
  await expect(page.locator('.mode')).toContainText('模拟模式')
  const message = '单文件便携包装启动回归（测试夹具）'
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(message)
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click()
  await expect(page.locator('.bubble').last()).toContainText('模拟回复')
  await expect(page.locator('.status').last()).toContainText('已完成', { timeout: 15000 })
  const snapshot = await page.evaluate(() => window.changli.snapshot())
  expect(snapshot.settings.mode).toBe('demo')
  expect(snapshot.messages.map(item => item.role)).toEqual(['user', 'assistant'])
  expect(snapshot.messages[0].content).toBe(message)
  expect(snapshot.messages[1].status).toBe('complete')
  mkdirSync(join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: join(root, 'test-results/portable.png') })
  expect(errors).toEqual([])
  await closeOwnWindow()
  const result = await waitForExit(20000)
  if (!result) throw new Error('关闭窗口后便携包装程序未在 20 秒内退出。')
  expect(result.error).toBeUndefined()
  expect(result.code).toBe(0)
  const databasePath = join(directory, 'chat.sqlite')
  expect(existsSync(databasePath)).toBe(true)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const rows = database.prepare('SELECT role,content,status FROM messages ORDER BY seq').all()
    expect(rows.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(rows[0].content).toBe(message)
    expect(rows[1].content).toContain('模拟回复')
    expect(rows[1].status).toBe('complete')
  } finally { database.close() }
  console.log(`便携版检查通过：${basename(executablePath)} 实际解压启动、本地页面与受限桥、模拟回复、SQLite 落盘、关闭窗口后包装进程正常退出。`)
} finally {
  await closeOwnWindow()
  if (!exited && !(await waitForExit(5000)) && wrapper.pid) {
    // 只清理本测试直接创建的包装进程及其子进程，不按名称关闭其他 Electron 应用。
    const killer = spawn('taskkill.exe', ['/PID', String(wrapper.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false })
    await new Promise(resolve => { killer.once('exit', resolve); killer.once('error', resolve) })
    await waitForExit(5000)
  }
  await browser?.close().catch(() => {})
  const absolute = resolve(directory)
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'changli-portable-')) throw new Error('测试清理路径不在预期临时目录内。')
  rmSync(absolute, { recursive: true, force: true })
}
