import { cpus, totalmem, freemem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { stat } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import type { Store } from './store'
import type { ToolRecord } from '../shared/types'

export const definitions = [
  { type: 'function', function: { name: 'system_status', description: '按用户请求读取真实 CPU 和内存状态。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'open_app', description: '只按用户明确请求启动本地已配置且已授权的应用。仅提交 appId，不得传入路径或命令。', parameters: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'], additionalProperties: false } } }
]
export async function fingerprint(target: string) {
  if (extname(target).toLowerCase() !== '.exe') throw new Error('首版只允许选择 .exe 应用。')
  if (['cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'rundll32.exe', 'regsvr32.exe'].includes(basename(target).toLowerCase())) throw new Error('首版不提供命令或脚本解释器入口。')
  let info
  try { info = await stat(target) }
  catch { throw new Error('无法读取启动目标，请重新选择程序并检查文件是否存在及访问权限。') }
  if (!info.isFile()) throw new Error('启动目标不是文件。')
  return `${target.toLowerCase()}:${info.size}:${info.mtimeMs}`
}
export async function hardware(signal: AbortSignal) {
  const sample = () => cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }))
  const before = sample(); await delay(350, undefined, { signal }); const after = sample()
  const idle = after.reduce((n, c, i) => n + c.idle - before[i].idle, 0)
  const total = after.reduce((n, c, i) => n + c.total - before[i].total, 0)
  const memoryTotal = totalmem(); const used = memoryTotal - freemem()
  return JSON.stringify({ sampledAt: new Date().toISOString(), sampleWindowMs: 350,
    cpu: { usagePercent: total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null },
    memory: { totalBytes: memoryTotal, usedBytes: used, usagePercent: Math.round(used / memoryTotal * 1000) / 10 },
    gpu: { status: 'unsupported' }, cpuTemperature: { status: 'unsupported' },
    note: '单次占用读数不能排除故障；本版本未实现 GPU 与温度传感器。' })
}

export class ToolExecutor {
  constructor(readonly store: Store, readonly launch: (path: string) => Promise<void>, readonly changed: () => void, readonly timeoutMs = 10000) {}
  async execute(id: string, sessionId: string, name: string, args: unknown, signal: AbortSignal, userText: string) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('调用 ID 无效。')
    const previous = this.store.tool(id)
    if (previous) return previous
    const record: ToolRecord = { id, sessionId, name: typeof name === 'string' ? name.slice(0, 80) : 'invalid', target: '', status: 'running', result: '', createdAt: new Date().toISOString() }
    this.store.saveTool(record); this.changed()
    const local = new AbortController()
    const cancel = () => local.abort()
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) local.abort()
    let timedOut = false, dispatched = false
    const timer = setTimeout(() => { timedOut = true; local.abort() }, this.timeoutMs)
    try {
      local.signal.throwIfAborted()
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数须为对象。')
      const values = args as Record<string, unknown>
      if (name === 'system_status') {
        if (Object.keys(values).length) throw new Error('状态工具不接受额外参数。')
        if (!/电脑状态|硬件状态|CPU|内存|系统状态/i.test(userText)) throw new Error('当前用户未请求电脑状态。')
        record.result = await hardware(local.signal)
      } else if (name === 'open_app') {
        if (Object.keys(values).length !== 1 || typeof values.appId !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(values.appId)) throw new Error('只允许合法 appId，禁止路径、命令和额外参数。')
        const target = this.store.apps().find(a => a.id === values.appId)
        if (!target) throw new Error('应用未配置，未启动任何替代应用。')
        record.target = target.id
        const request = userText.trim().match(/^(?:长离[，,、\s]*)?(?:请)?打开\s*(.+?)[。！!\s]*$/)
        if (!request || ![target.id, target.name].includes(request[1])) throw new Error('当前请求未明确指定该应用；请使用“打开 应用名”。')
        if (request[1] === target.name && this.store.apps().filter(a => a.name === target.name).length > 1) throw new Error('有多个同名应用，请先修改名称以区分目标。')
        if (!target.approved) { record.status = 'waiting'; throw new Error('应用尚未获准，请在工具设置中授权，再明确发起新请求。') }
        if (await fingerprint(target.target) !== target.fingerprint) {
          this.store.saveApp({ ...target, approved: false }); throw new Error('启动目标已变化，旧授权失效，请重新选择并授权。')
        }
        local.signal.throwIfAborted()
        // 同步核验当前授权后立即提交，不在核验与提交之间等待其他任务。
        if (!this.store.apps().some(a => a.id === target.id && a.approved && a.fingerprint === target.fingerprint)) throw new Error('授权已撤销。')
        dispatched = true
        const operation = this.launch(target.target)
        await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          if (local.signal.aborted) reject(new Error('调用已中止。'))
          else local.signal.addEventListener('abort', () => reject(new Error('调用已中止。')), { once: true })
        })])
        record.result = '操作系统已接受应用启动；不代表应用已完成登录、播放或内部操作。'
      } else throw new Error('未知工具，已拒绝。')
      record.status = 'success'
    } catch (error) {
      if (dispatched && local.signal.aborted) { record.status = 'uncertain'; record.result = '启动已提交系统，无法保证撤回；最终结果不确定，不会自动重放。' }
      else if (local.signal.aborted) { record.status = timedOut ? 'timeout' : 'cancelled'; record.result = timedOut ? '工具超过 10 秒。' : '已停止，未再提交新操作。' }
      else { if (record.status !== 'waiting') record.status = 'failed'; record.result = name === 'open_app' && dispatched ? '操作系统未接受启动，请检查应用目标。' : error instanceof Error ? error.message : '工具失败。' }
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); this.store.saveTool(record); this.changed() }
    return record
  }
}
