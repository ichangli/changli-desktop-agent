import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import type { Store } from './store'
import type { DesktopPreferences } from '../shared/types'

// 原创几何托盘标记，随后台代码打包，无外部图片依赖。
const trayIcon = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjklEQVR4nO3USwqAMAwE0N7KG3hGF97Lk7hWEAXR2s5Miq2YQJbJPOgnBK+9hr5b3mwHOKAIYJ7GrasAjnAVYQJcwxWEDHgKZxESIBfOIGgAGo4iKAAbjiBggBqeQ0AAa3gK8Q1A9SNo4hI28Qyb+IhQBLpHBqQQzA4TIIZg582AM0KZLQKwtAMccAP8tlbLm0wGj4lfJQAAAABJRU5ErkJggg=='
export function setupDesktop(win: BrowserWindow, store: Store, cleanup: () => Promise<void>) {
  let tray: Tray | null = null
  let quitting = false, finished = false
  let shutdown: Promise<void> | null = null
  const available = () => !!tray && !tray.isDestroyed()
  const preferences = (): DesktopPreferences => ({ closeAction: store.get('closeAction') === 'tray' ? 'tray' : 'quit', trayAvailable: available() })
  function show() {
    if (quitting || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
  }
  function hide() {
    if (quitting || win.isDestroyed()) return
    if (!available()) throw new Error('系统托盘不可用，窗口保持显示。')
    win.hide()
  }
  function quit() {
    if (shutdown) return
    quitting = true
    shutdown = (async () => {
      try { await cleanup() }
      finally {
        if (available()) tray!.destroy()
        finished = true
        if (!win.isDestroyed()) win.destroy()
        app.quit()
      }
    })().catch(() => { /* cleanup 已尝试，退出阶段不输出私人数据。 */ })
  }
  try {
    const icon = nativeImage.createFromDataURL('data:image/png;base64,' + trayIcon)
    if (icon.isEmpty()) throw new Error('托盘图标不可用')
    tray = new Tray(icon)
    tray.setToolTip('长离桌面助手')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: show },
      { label: '隐藏到托盘', click: hide },
      { type: 'separator' },
      { label: '退出长离', click: quit }
    ]))
    tray.on('click', show)
    tray.on('double-click', show)
  } catch {
    if (tray && !tray.isDestroyed()) tray.destroy()
    tray = null
  }
  win.on('close', event => {
    if (finished) return
    event.preventDefault()
    if (!quitting && preferences().closeAction === 'tray' && available()) hide()
    else quit()
  })
  app.on('before-quit', event => { if (!finished) { event.preventDefault(); quit() } })
  // Windows 注销/关机不应被“关闭到托盘”的偏好拦截；强制终止仍由数据库恢复中断状态。
  win.on('query-session-end', () => { quitting = true })
  win.on('session-end', quit)
  app.on('second-instance', show)
  app.on('activate', show)
  return {
    preferences, hide, quit,
    save(value: { closeAction: unknown }) {
      if (!value || !['quit', 'tray'].includes(value.closeAction as string)) throw new Error('关闭窗口行为无效。')
      if (value.closeAction === 'tray' && !available()) throw new Error('系统托盘不可用，请选择直接退出。')
      store.set('closeAction', value.closeAction as string)
      return preferences()
    }
  }
}
