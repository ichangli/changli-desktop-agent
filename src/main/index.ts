import { app, BrowserWindow, ipcMain, safeStorage, dialog, net, shell } from 'electron'
import { join, resolve } from 'node:path'
import { mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { open, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { makeBackup, parseBackup, restoreBackup, conversationMarkdown, maxBackupBytes, type Backup } from './data'
import { ToolExecutor, fingerprint } from './tools'
import { registerSelectedApp, renameApp } from './apps'
import { Store } from './store'
import { setupDesktop } from './desktop'
import { createUpdateService } from './updates'
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
  const currentVersion: string = app.isPackaged ? app.getVersion() : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const updates = createUpdateService(currentVersion, (input, init) => net.fetch(input instanceof URL ? input.href : input, init), url => shell.openExternal(url))
  handle('update-info', () => updates.info())
  handle('update-check', () => updates.check())
  handle('update-open', () => updates.openPage())
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
  let dataBusy = false
  let restoreCandidate: { token: string; data: Backup } | null = null
  function idle() { if (chat.active || panelRun) throw new Error('请先停止生成或等待工具结束。') }
  async function fileAction<T>(action: () => Promise<T>) {
    if (dataBusy) throw new Error('请先完成当前文件操作。')
    idle(); dataBusy = true
    try { return await action() } finally { dataBusy = false }
  }
  async function saveText(defaultPath: string, extension: string, text: string) {
    const choice = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: extension === 'json' ? 'JSON 备份' : 'Markdown 聊天记录', extensions: [extension] }] })
    if (choice.canceled || !choice.filePath) return '已取消，未写入文件。'
    try { await writeFile(choice.filePath, text, { encoding: 'utf8', mode: 0o600 }) }
    catch { throw new Error('文件写入失败，请检查保存位置和磁盘空间。') }
    return '文件已保存。'
  }
  handle('conversation-rename', (value: { id: string; title: string }) => {
    if (!value) throw new Error('会话参数无效。')
    store.renameConversation(value.id, value.title); chat.emit(); return chat.snapshot()
  })
  handle('conversation-delete', (id: string) => {
    idle(); store.deleteConversation(id); chat.selected = store.get('selected'); chat.emit(); return chat.snapshot()
  })
  handle('conversation-search', (query: string) => store.search(query))
  handle('conversation-export', (id: string) => fileAction(async () => {
    if (typeof id !== 'string') throw new Error('会话参数无效。')
    const text = conversationMarkdown(store, id)
    return saveText('长离聊天-' + new Date().toISOString().slice(0, 10) + '.md', 'md', text)
  }))
  handle('data-backup', () => fileAction(async () => {
    const text = JSON.stringify(makeBackup(store), null, 2)
    if (Buffer.byteLength(text) > maxBackupBytes) throw new Error('数据超过 50 MiB，请先分会话导出并整理记录。')
    return saveText('长离备份-' + new Date().toISOString().slice(0, 10) + '.json', 'json', text)
  }))
  handle('data-prepare-restore', () => fileAction(async () => {
    restoreCandidate = null
    const choice = await dialog.showOpenDialog(win, { title: '选择聊天与记忆备份', properties: ['openFile'], filters: [{ name: 'JSON 备份', extensions: ['json'] }] })
    if (choice.canceled || !choice.filePaths[0]) return null
    let text: string
    try {
      const file = await open(choice.filePaths[0], 'r')
      try {
        const size = (await file.stat()).size
        if (size > maxBackupBytes) throw new Error()
        const buffer = Buffer.alloc(size + 1)
        let count = 0, read = 0
        do { read = (await file.read(buffer, count, buffer.length - count, null)).bytesRead; count += read } while (read && count < buffer.length)
        if (count > size) throw new Error()
        text = buffer.subarray(0, count).toString('utf8')
      } finally { await file.close() }
    } catch { throw new Error('备份读取失败或超过 50 MiB，未导入任何数据。') }
    idle()
    const data = parseBackup(text), token = randomUUID()
    restoreCandidate = { token, data }
    return { token, conversations: data.conversations.length, messages: data.messages.length, memories: data.memories.length }
  }))
  handle('data-cancel-restore', () => { restoreCandidate = null })
  handle('data-restore', (token: string) => {
    idle()
    if (dataBusy || !restoreCandidate || restoreCandidate.token !== token) throw new Error('备份确认已失效，请重新选择文件。')
    const result = restoreBackup(store, restoreCandidate.data)
    restoreCandidate = null; chat.emit()
    return `已恢复 ${result.conversations} 段会话、${result.messages} 条消息和 ${result.memories} 条新记忆。原有数据已保留。`
  })
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
  const desktop = setupDesktop(win, store, async () => {
    panelRun?.abort()
    await Promise.allSettled([chat.stop('interrupted'), panelTask])
    store.close()
  })
  handle('desktop-preferences', () => desktop.preferences())
  handle('desktop-save', (value: { closeAction: unknown }) => desktop.save(value))
  handle('window-hide', () => desktop.hide())
  handle('app-quit', () => { setImmediate(() => desktop.quit()) })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}).catch(() => { dialog.showErrorBox('长离桌面助手启动失败', '无法初始化数据或应用资源，请检查数据目录权限和构建文件。'); app.quit() })
