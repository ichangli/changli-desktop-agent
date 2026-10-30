import { randomUUID, createHash } from 'node:crypto'
import type { Conversation, Message, Memory } from '../shared/types'
import type { Store } from './store'

export const maxBackupBytes = 50 * 1024 * 1024
export interface Backup {
  format: 'changli-data'
  version: 1
  createdAt: string
  conversations: Conversation[]
  messages: Message[]
  memories: Memory[]
}
const invalid = () => new Error('备份格式无效或超出限制，未导入任何数据。')
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function fields(value: unknown, names: string[]) {
  const r = record(value)
  if (Object.keys(r).length !== names.length || names.some(n => !(n in r))) throw invalid()
  return r
}
function str(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) throw invalid()
  return value
}
function date(value: unknown) {
  const s = str(value, 40, true)
  if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s))) throw invalid()
  return s
}
export function parseBackup(text: string): Backup {
  if (Buffer.byteLength(text) > maxBackupBytes) throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw invalid() }
  const data = fields(parsed, ['format', 'version', 'createdAt', 'conversations', 'messages', 'memories'])
  if (data.format !== 'changli-data' || data.version !== 1) throw invalid()
  if (!Array.isArray(data.conversations) || data.conversations.length > 5000 || !Array.isArray(data.messages) || data.messages.length > 100000 || !Array.isArray(data.memories) || data.memories.length > 100) throw invalid()
  const conversations = data.conversations.map(value => {
    const c = fields(value, ['id', 'title', 'createdAt'])
    return { id: str(c.id, 100, true), title: str(c.title, 80, true), createdAt: date(c.createdAt) }
  })
  const ids = new Set(conversations.map(c => c.id)), messageIds = new Set<string>(), memoryIds = new Set<string>()
  if (ids.size !== conversations.length) throw invalid()
  const messages = data.messages.map(value => {
    const m = fields(value, ['id', 'sessionId', 'role', 'content', 'status', 'createdAt', 'error'])
    const id = str(m.id, 100, true), sessionId = str(m.sessionId, 100, true)
    if (messageIds.has(id) || !ids.has(sessionId) || !['user', 'assistant'].includes(m.role as string) || !['complete', 'generating', 'stopped', 'interrupted', 'failed'].includes(m.status as string)) throw invalid()
    messageIds.add(id)
    return { id, sessionId, role: m.role as Message['role'], content: str(m.content, 1000000), status: m.status as Message['status'], createdAt: date(m.createdAt), error: str(m.error, 10000) }
  })
  const memories = data.memories.map(value => {
    const m = fields(value, ['id', 'content', 'category', 'source', 'createdAt', 'updatedAt'])
    const id = str(m.id, 100, true)
    if (memoryIds.has(id) || !['fact', 'roleplay'].includes(m.category as string)) throw invalid()
    memoryIds.add(id)
    return { id, content: str(m.content, 1000, true), category: m.category as Memory['category'], source: str(m.source, 200), createdAt: date(m.createdAt), updatedAt: date(m.updatedAt) }
  })
  return { format: 'changli-data', version: 1, createdAt: date(data.createdAt), conversations, messages, memories }
}
export function makeBackup(store: Store): Backup {
  const conversations = store.conversations().reverse()
  const data: Backup = { format: 'changli-data', version: 1, createdAt: new Date().toISOString(), conversations,
    messages: conversations.flatMap(c => store.messages(c.id)), memories: store.memories().reverse() }
  return parseBackup(JSON.stringify(data))
}
export function restoreBackup(store: Store, data: Backup) {
  data = parseBackup(JSON.stringify(data))
  // 按内容判重，修改 JSON 的缩进/导出时间也不会重复恢复同一份数据。
  const digest = createHash('sha256').update(JSON.stringify({ conversations: data.conversations, messages: data.messages, memories: data.memories })).digest('hex')
  const marker = 'restored:' + digest
  if (store.get(marker)) throw new Error('这份备份已经恢复过，未重复导入。')
  const existing = store.memories()
  const memories: Memory[] = []
  for (const m of data.memories) if (![...existing, ...memories].some(x => x.content === m.content && x.category === m.category)) memories.push(m)
  if (existing.length + memories.length > 100) throw new Error('恢复后记忆将超过 100 条，请先整理现有记忆。未导入任何数据。')
  const sessions = new Map(data.conversations.map(c => [c.id, randomUUID()]))
  const messageIds = new Map(data.messages.map(m => [m.id, randomUUID()]))
  store.db.exec('BEGIN')
  try {
    for (const c of data.conversations) store.db.prepare('INSERT INTO conversations VALUES (?,?,?)').run(sessions.get(c.id)!, c.title, c.createdAt)
    for (const m of data.messages) store.db.prepare('INSERT INTO messages(id,sessionId,role,content,status,createdAt,error) VALUES (?,?,?,?,?,?,?)').run(messageIds.get(m.id)!, sessions.get(m.sessionId)!, m.role, m.content, m.status === 'generating' ? 'interrupted' : m.status, m.createdAt, m.error)
    for (const m of memories) {
      const oldId = m.source.startsWith('会话消息：') ? m.source.slice(5) : ''
      const source = messageIds.has(oldId) ? '会话消息：' + messageIds.get(oldId) : m.source
      store.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?)').run(randomUUID(), m.content, m.category, source, m.createdAt, m.updatedAt)
    }
    store.set(marker, new Date().toISOString())
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
  return { conversations: data.conversations.length, messages: data.messages.length, memories: memories.length }
}
export function conversationMarkdown(store: Store, id: string) {
  const conversation = store.conversations().find(c => c.id === id)
  if (!conversation) throw new Error('会话不存在。')
  const labels = { complete: '已完成', generating: '生成中', interrupted: '已中断', stopped: '已停止', failed: '失败' }
  return '# ' + conversation.title.replace(/[\r\n]/g, ' ') + '\n\n创建时间：' + conversation.createdAt + '\n\n' + store.messages(id).map(m => `## ${m.role === 'user' ? '你' : '长离'} · ${m.createdAt} · ${labels[m.status]}\n\n${m.content}\n${m.error ? '\n错误：' + m.error + '\n' : ''}`).join('\n')
}
