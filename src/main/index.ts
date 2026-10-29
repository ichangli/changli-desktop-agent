import { app, BrowserWindow, ipcMain, safeStorage, dialog } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { ToolExecutor, fingerprint } from './tools'
import { registerSelectedApp, renameApp } from './apps'
import { Store } from './store'
import { Chat } from './chat'
import { runtimePrompt, stream, validateEndpoint } from './model'
import type { Settings, SettingsInput, MemoryInput, Workspace } from '../shared/types'

const root = resolve(import.meta.dirname, '../..')
app.setName('长离桌面助手')
app.setPath('userData', process.env.CHANGLI_DATA_DIR || join(app.getPath('appData'), app.isPackaged ? 'ChangliDesktopAgent' : 'ChangliDesktopAgent-dev'))
if (!app.requestSingleInstanceLock()) app.quit()
else void app.whenReady().then(() => {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const store = new Store(join(app.getPath('userData'), 'chat.sqlite'))
  const settings = (): Settings => ({ mode: store.get('mode') === 'chat-completions' ? 'chat-completions' : 'demo', endpoint: store.get('endpoint'), model: store.get('model'), hasKey: !!store.get('credential') })
  const key = () => {
    if (!store.get('credential')) return ''
    try { return safeStorage.decryptString(Buffer.from(store.get('credential'), 'base64')) }
    catch { throw new Error('无法解密本机凭据，请在设置中重新填写。') }
  }
  const win = new BrowserWindow({ width: 1180, height: 800, minWidth: 850, minHeight: 600,
    backgroundColor: '#f7f4ee', title: '长离桌面助手', autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', e => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false))
  const promptPath = app.isPackaged ? join(process.resourcesPath, 'prompts/changli.md') : join(root, 'prompts/changli.md')
  const chat = new Chat(store, runtimePrompt(readFileSync(promptPath, 'utf8')), settings, key,
    value => { if (!win.isDestroyed()) win.webContents.send('changli:change', value) })
  const workspace = (): Workspace => ({ memories: store.memories(), apps: store.apps(), tools: store.tools() })
  const executor = new ToolExecutor(store, target => new Promise<void>((resolve, reject) => {
    const child = spawn(target, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', () => reject(new Error('启动失败。')))
    child.once('spawn', () => { child.unref(); resolve() })
  }), () => chat.emit())
  chat.executor = executor
  function handle(name: string, action: (...args: any[]) => unknown) {
    ipcMain.handle(`changli:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效来源。')
      return action(...args)
    })
  }
  handle('snapshot', () => chat.snapshot())
  handle('workspace', workspace)
  handle('memory-save', (value: MemoryInput) => { store.saveMemory(value); chat.emit(); return workspace() })
  handle('memory-delete', (id: string) => { if (typeof id !== 'string') throw new Error('记忆 ID 无效。'); store.deleteMemory(id); chat.emit(); return workspace() })
  handle('app-configure', async () => {
    const selection = await dialog.showOpenDialog(win, { title: '选择应用启动文件（保存后还需明确授权）', properties: ['openFile'], filters: [{ name: 'Windows 应用', extensions: ['exe'] }] })
    if (selection.canceled) return workspace()
    const target = selection.filePaths[0]
    await registerSelectedApp(store, target)
    chat.emit(); return workspace()
  })
  handle('app-rename', (value: { id: string; name: string }) => { renameApp(store, value); chat.emit(); return workspace() })
  handle('app-grant', async (value: { id: string; approved: boolean }) => {
    if (!value || typeof value.id !== 'string' || typeof value.approved !== 'boolean') throw new Error('授权参数无效。')
    const target = store.apps().find(a => a.id === value.id)
    if (!target) throw new Error('应用不存在。')
    const signature = value.approved ? await fingerprint(target.target) : target.fingerprint
    const current = store.apps().find(a => a.id === value.id)
    if (!current || current.fingerprint !== target.fingerprint) throw new Error('配置已变化，请重新操作。')
    store.saveApp({ ...current, approved: value.approved, fingerprint: signature }); chat.emit(); return workspace()
  })
  let panelRun: AbortController | null = null
  let panelTask: Promise<unknown> | null = null
  handle('tool-run', async (value: { name: string; args: unknown; id: string }) => {
    if (!value || typeof value.name !== 'string' || typeof value.id !== 'string') throw new Error('工具请求无效。')
    if (chat.active || panelRun) throw new Error('请等待当前请求结束或先停止，再使用面板工具。')
    const args = value.args as { appId?: unknown } | null
    panelRun = new AbortController()
    panelTask = executor.execute(value.id, chat.selected, value.name, value.args, panelRun.signal,
      value.name === 'system_status' ? '查询电脑状态' : typeof args?.appId === 'string' ? `打开 ${args.appId}` : '')
    try { await panelTask } finally { panelRun = null; panelTask = null }
    return workspace()
  })
  handle('create', () => chat.create())
  handle('select', (id: string) => chat.select(id))
  handle('send', (text: string) => { if (panelRun) throw new Error('请先等待面板工具结束。'); return chat.send(text) })
  handle('retry', (id: string) => chat.retry(id))
  handle('stop', () => { panelRun?.abort(); return chat.stop() })
  handle('settings', (value: SettingsInput) => {
    if (chat.active) throw new Error('请先停止生成再修改连接。')
    if (!value || !['demo', 'chat-completions'].includes(value.mode) || typeof value.endpoint !== 'string' || typeof value.model !== 'string' || value.model.length > 200 || (value.key !== undefined && (typeof value.key !== 'string' || value.key.length > 8192))) throw new Error('连接设置格式无效。')
    const endpoint = value.endpoint.trim() ? validateEndpoint(value.endpoint.trim()) : ''
    if (value.mode === 'chat-completions' && (!endpoint || !value.model.trim())) throw new Error('请填写接口完整地址和模型。')
    const changedTarget = endpoint !== store.get('endpoint')
    let credential = changedTarget || value.clearKey ? '' : store.get('credential')
    if (value.key) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('本机凭据加密不可用，未保存密钥。')
      credential = safeStorage.encryptString(value.key).toString('base64')
    }
    store.db.exec('BEGIN')
    try { store.set('mode', value.mode); store.set('endpoint', endpoint); store.set('model', value.model.trim()); store.set('credential', credential); store.db.exec('COMMIT') }
    catch { store.db.exec('ROLLBACK'); throw new Error('设置保存失败。') }
    chat.emit(); return chat.snapshot()
  })
  handle('test', async () => {
    if (settings().mode === 'demo') return '当前为模拟模式，未发起模型网络请求。'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      for await (const _chunk of stream(settings(), key(), [{ role: 'user', content: '请只回复：连接成功' }], controller.signal)) { break }
      return '已收到模型文字流。连接检查会向所填服务发送简短测试请求。'
    } catch (error) { if (controller.signal.aborted) throw new Error('连接检查超过 15 秒。'); throw error }
    finally { clearTimeout(timer) }
  })
  let closing = false
  win.on('close', event => {
    if (closing) return
    event.preventDefault(); closing = true; panelRun?.abort()
    void Promise.allSettled([chat.stop('interrupted'), panelTask]).then(() => { store.close(); win.destroy(); app.quit() }).catch(() => { win.destroy(); app.quit() })
  })
  app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.focus() })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}).catch(() => { dialog.showErrorBox('长离桌面助手启动失败', '无法初始化数据或应用资源，请检查数据目录权限和构建文件。'); app.quit() })
