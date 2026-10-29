import { _electron as electron, expect } from '@playwright/test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const executablePath = resolve(process.argv[2] || join(root, 'release/win-unpacked/长离桌面助手.exe'))
const expectedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (!existsSync(executablePath)) throw new Error('未找到打包程序，请先运行 npm run pack:win，或传入解压后 .exe 的绝对路径。')

const directory = mkdtempSync(join(tmpdir(), 'changli-packaged-'))
const env = {
  ...process.env,
  CHANGLI_DATA_DIR: directory,
  ELECTRON_RENDERER_URL: 'https://example.invalid/should-not-load'
}
delete env.ELECTRON_RUN_AS_NODE
const fakeKey = 'PACKAGED_TEST_KEY_ONLY_NOT_REAL'
const issues = []
let app

async function api(page, method, value) {
  return page.evaluate(({ method, value }) => window.changli[method](value), { method, value })
}

async function launch() {
  app = await electron.launch({ executablePath, args: [], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.on('pageerror', error => issues.push(error.message))
  await page.getByRole('button', { name: '＋ 新的对话', exact: true }).waitFor()
  await expect(page.locator('.mode')).toBeVisible()
  expect(page.url()).toMatch(/^file:\/\//)
  const details = await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const appPath = app.getAppPath()
    const files = []
    function walk(directory, prefix = '') {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isDirectory()) walk(path.join(directory, entry.name), relative + '/')
        else files.push(relative)
      }
    }
    walk(appPath)
    const promptPath = path.join(process.resourcesPath, 'prompts/changli.md')
    return {
      packaged: app.isPackaged,
      version: app.getVersion(),
      dataDirectory: app.getPath('userData'),
      appPath,
      files,
      hasPrompt: fs.existsSync(promptPath) && fs.readFileSync(promptPath, 'utf8').includes('## 运行时角色提示')
    }
  })
  expect(details.packaged).toBe(true)
  expect(details.version).toBe(expectedVersion)
  expect(resolve(details.dataDirectory)).toBe(resolve(directory))
  expect(details.appPath).toMatch(/app\.asar$/)
  expect(details.hasPrompt).toBe(true)
  expect(details.files).toContain('out/main/index.js')
  expect(details.files).toContain('out/preload/index.cjs')
  expect(details.files).toContain('out/renderer/index.html')
  for (const file of details.files) {
    expect(file).not.toMatch(/^(?:src|tests|runtime|test-results|\.git)(?:\/|$)/)
    expect(file).not.toMatch(/(?:^|\/)\.env(?:\.|$)/)
    expect(file).not.toMatch(/\.(?:sqlite(?:-[a-z]+)?|db(?:-[a-z]+)?|log)$/i)
  }
  return page
}

async function send(page, text) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送 ↑', exact: true }).click()
}

try {
  let page = await launch()
  await expect(page.locator('.mode')).toContainText('模拟模式')
  await send(page, '独立打包程序的第一段对话')
  await expect(page.locator('.bubble').last()).toContainText('模拟回复')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.locator('.status').last()).toContainText('已停止')
  const stopped = await page.locator('.bubble').last().textContent()
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(await page.locator('.bubble').last().textContent()).toBe(stopped)

  await api(page, 'create')
  await send(page, '独立打包程序的第二段对话')
  await expect(page.locator('.status').last()).toContainText('已完成', { timeout: 15000 })
  const selectedId = (await api(page, 'snapshot')).selectedId
  await api(page, 'saveMemory', { content: '打包回归夹具：技术回答先给结论', category: 'fact', source: '打包回归测试夹具' })
  await api(page, 'saveSettings', {
    mode: 'demo', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', key: fakeKey
  })
  const snapshot = await api(page, 'snapshot')
  expect(snapshot.settings.hasKey).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain(fakeKey)
  for (const file of readdirSync(directory).filter(name => name.startsWith('chat.sqlite')))
    expect(readFileSync(join(directory, file)).includes(Buffer.from(fakeKey))).toBe(false)

  await app.close()
  page = await launch()
  expect((await api(page, 'snapshot')).selectedId).toBe(selectedId)
  await expect(page.locator('nav button')).toHaveCount(2)
  await expect(page.locator('.bubble').first()).toHaveText('独立打包程序的第二段对话')
  await expect(page.locator('.status').last()).toContainText('已完成')
  expect((await api(page, 'snapshot')).settings.hasKey).toBe(true)
  const memories = (await api(page, 'workspace')).memories
  expect(memories).toHaveLength(1)
  expect(memories[0].content).toBe('打包回归夹具：技术回答先给结论')

  await page.getByRole('button', { name: '电脑工具', exact: false }).click()
  await page.getByRole('button', { name: '查询电脑状态', exact: true }).click()
  await expect(page.locator('.tool-status').first()).toHaveText('成功')
  const record = (await api(page, 'workspace')).tools[0]
  const sample = JSON.parse(record.result)
  expect(sample.memory.totalBytes).toBeGreaterThan(0)
  expect(sample.memory.usedBytes).toBeGreaterThan(0)
  expect(sample.cpu.usagePercent).toBeGreaterThanOrEqual(0)
  expect(sample.cpu.usagePercent).toBeLessThanOrEqual(100)
  expect(Number.isFinite(Date.parse(sample.sampledAt))).toBe(true)
  await expect(page.locator('pre').first()).toContainText('采样时间')
  await expect(page.locator('pre').first()).toContainText('不支持')
  mkdirSync(join(root, 'test-results'), { recursive: true })
  await page.screenshot({ path: join(root, 'test-results/packaged.png') })
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined')
  expect(issues).toEqual([])
  console.log(`打包应用检查通过（${expectedVersion}）：真实独立 exe、ASAR/人设资源、正式模式本地页面、流式与停止、会话/记忆/凭据重启恢复、真实硬件采样；仅使用临时数据和假密钥。`)
} finally {
  await app?.close().catch(() => {})
  const absolute = resolve(directory)
  if (!absolute.startsWith(resolve(tmpdir()) + sep + 'changli-packaged-')) throw new Error('测试清理路径不在预期临时目录内。')
  rmSync(absolute, { recursive: true, force: true })
}
