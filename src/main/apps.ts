import { randomUUID } from 'node:crypto'
import { basename, extname, resolve } from 'node:path'
import type { Store } from './store'
import { fingerprint } from './tools'

// 仅接收主进程原生文件选择器的结果，渲染页面不能指定启动路径或内部 ID。
export async function registerSelectedApp(store: Store, target: string) {
  const signature = await fingerprint(target)
  const apps = store.apps()
  const existing = apps.find(a => resolve(a.target).toLowerCase() === resolve(target).toLowerCase())
  if (existing) {
    store.saveApp({ ...existing, approved: existing.approved && existing.fingerprint === signature, fingerprint: signature })
    return existing.id
  }
  const base = basename(target, extname(target)).trim().slice(0, 70) || '新应用'
  let name = base
  for (let index = 2; apps.some(a => a.name === name); index++) name = `${base}（${index}）`
  const id = `app_${randomUUID()}`
  store.saveApp({ id, name, target, approved: false, fingerprint: signature })
  return id
}

export function renameApp(store: Store, value: { id: string; name: string }) {
  if (!value || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80)
    throw new Error('应用名称须为 1～80 个字符。')
  const existing = store.apps().find(a => a.id === value.id)
  if (!existing) throw new Error('应用不存在。')
  const name = value.name.trim()
  if (store.apps().some(a => a.id !== value.id && a.name === name)) throw new Error('已有同名应用，请换一个便于区分的名称。')
  store.saveApp({ ...existing, name })
}
