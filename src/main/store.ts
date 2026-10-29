import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Conversation, Message, Status, Memory, MemoryInput, AllowedApp, ToolRecord } from '../shared/types'

export class Store {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      sessionId TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT NOT NULL, createdAt TEXT NOT NULL, error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY, name TEXT NOT NULL, target TEXT NOT NULL, approved INTEGER NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, createdAt TEXT NOT NULL);`)
    this.db.prepare("UPDATE messages SET status='interrupted' WHERE status='generating'").run()
    this.db.prepare("UPDATE tools SET status='uncertain',result='程序在调用结束前退出，实际结果不确定，不会自动重放。' WHERE status='running'").run()
    this.db.prepare("UPDATE tools SET status='cancelled',result='程序退出，尚未执行。' WHERE status='waiting'").run()
  }
  conversations() { return this.db.prepare('SELECT * FROM conversations ORDER BY rowid DESC').all() as unknown as Conversation[] }
  create() {
    const id = randomUUID()
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run(id, '新的对话', new Date().toISOString())
    this.set('selected', id)
    return id
  }
  messages(id: string) { return this.db.prepare('SELECT id,sessionId,role,content,status,createdAt,error FROM messages WHERE sessionId=? ORDER BY seq').all(id) as unknown as Message[] }
  add(sessionId: string, role: Message['role'], content: string, status: Status) {
    const m: Message = { id: randomUUID(), sessionId, role, content, status, createdAt: new Date().toISOString(), error: '' }
    this.db.prepare('INSERT INTO messages(id,sessionId,role,content,status,createdAt,error) VALUES (?,?,?,?,?,?,?)').run(m.id, sessionId, role, content, status, m.createdAt, '')
    if (role === 'user' && this.messages(sessionId).filter(x => x.role === 'user').length === 1)
      this.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(content.slice(0, 24), sessionId)
    return m
  }
  update(m: Message) { this.db.prepare('UPDATE messages SET content=?,status=?,error=? WHERE id=?').run(m.content, m.status, m.error, m.id) }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value as string | undefined) ?? '' }
  set(key: string, value: string) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  memories() { return this.db.prepare('SELECT * FROM memories ORDER BY updatedAt DESC,rowid DESC').all() as unknown as Memory[] }
  saveMemory(value: MemoryInput) {
    if (!value || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 1000 || !['fact', 'roleplay'].includes(value.category)) throw new Error('记忆须为 1～1000 字符，并明确选择现实事实/偏好或角色互动约定。')
    const previous = value.id ? this.memories().find(m => m.id === value.id) : undefined
    if (value.id && !previous) throw new Error('记忆不存在，请刷新列表。')
    if (!previous && this.memories().length >= 100) throw new Error('记忆数量已达 100 条，请先整理。')
    if (!previous && this.memories().some(m => m.content === value.content.trim() && m.category === value.category)) throw new Error('相同记忆已存在，请编辑原条目。')
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,category=excluded.category,updatedAt=excluded.updatedAt').run(previous?.id ?? randomUUID(), value.content.trim(), value.category, previous?.source ?? (typeof value.source === 'string' ? value.source.slice(0, 200) : '记忆面板主动新增'), previous?.createdAt ?? now, now)
  }
  deleteMemory(id: string) { this.db.prepare('DELETE FROM memories WHERE id=?').run(id) }
  recall() {
    let size = 0
    return this.memories().slice(0, 8).filter(m => { size += m.content.length; return size <= 4000 })
  }
  apps() { return this.db.prepare('SELECT * FROM apps ORDER BY name').all().map(a => ({ ...a, approved: !!a.approved })) as unknown as AllowedApp[] }
  saveApp(a: AllowedApp) { this.db.prepare('INSERT INTO apps VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,target=excluded.target,approved=excluded.approved,fingerprint=excluded.fingerprint').run(a.id, a.name, a.target, a.approved ? 1 : 0, a.fingerprint) }
  tools() { return this.db.prepare('SELECT * FROM tools ORDER BY rowid DESC LIMIT 100').all() as unknown as ToolRecord[] }
  tool(id: string) { return this.db.prepare('SELECT * FROM tools WHERE id=?').get(id) as unknown as ToolRecord | undefined }
  saveTool(t: ToolRecord) { this.db.prepare('INSERT INTO tools VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target=excluded.target,status=excluded.status,result=excluded.result').run(t.id, t.sessionId, t.name, t.target, t.status, t.result, t.createdAt) }
  close() { this.db.close() }
}
