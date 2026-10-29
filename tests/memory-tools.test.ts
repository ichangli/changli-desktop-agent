import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { Store } from '../src/main/store'
import { ToolExecutor, fingerprint, hardware } from '../src/main/tools'
import { Chat } from '../src/main/chat'
import type { Settings } from '../src/shared/types'

test('明确记忆增改删、类别、数量边界与保存失败', () => {
  const store = new Store(':memory:')
  store.saveMemory({ content: '技术回答简短', category: 'fact' })
  const id = store.memories()[0].id
  store.saveMemory({ id, content: '技术回答先给结论', category: 'fact' })
  store.saveMemory({ content: '窗边读书是共创情节', category: 'roleplay' })
  assert.equal(store.memories().find(m => m.id === id)?.content, '技术回答先给结论')
  assert.throws(() => store.saveMemory({ content: '', category: 'fact' }))
  assert.throws(() => store.saveMemory({ content: '技术回答先给结论', category: 'fact' }))
  store.db.exec('PRAGMA query_only=ON')
  assert.throws(() => store.saveMemory({ content: '不会保存', category: 'fact' }))
  assert.equal(store.memories().length, 2)
  store.db.exec('PRAGMA query_only=OFF')
  store.deleteMemory(id); assert.equal(store.memories().length, 1)
  for (let i = 0; i < 12; i++) store.saveMemory({ content: `偏好 ${i}`, category: 'fact' })
  assert.ok(store.recall().length <= 8); store.close()
})

test('真实 CPU/内存采样带单位、时间及不支持标记', async () => {
  const result = JSON.parse(await hardware(new AbortController().signal))
  assert.ok(Date.parse(result.sampledAt) > 0)
  assert.ok(result.cpu.usagePercent >= 0 && result.cpu.usagePercent <= 100)
  assert.ok(result.memory.totalBytes > result.memory.usedBytes && result.memory.usedBytes > 0)
  assert.equal(result.gpu.status, 'unsupported'); assert.equal(result.cpuTemperature.status, 'unsupported')
})

test('应用校验、授权撤销、目标变化、防重复、失败/取消/超时及重启结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'changli-tools-'))
  const path = join(dir, 'fixture.exe'); writeFileSync(path, 'stub-not-real-exe')
  const db = join(dir, 'test.sqlite')
  let store = new Store(db), launched = 0
  try {
    const signature = await fingerprint(path)
    store.saveApp({ id: 'fixture', name: '测试应用', target: path, approved: true, fingerprint: signature })
    const executor = new ToolExecutor(store, async () => { launched++ }, () => {})
    const run = (id: string, name: string, args: unknown, text = '打开 测试应用') => executor.execute(id, 'session', name, args, new AbortController().signal, text)
    assert.equal((await run('a', 'open_app', { appId: 'fixture' })).status, 'success')
    assert.equal((await run('a', 'open_app', { appId: 'fixture' })).status, 'success'); assert.equal(launched, 1)
    for (const [id, name, args, text] of [
      ['unknown', 'open_app', { appId: 'unknown' }, '打开 unknown'],
      ['path', 'open_app', { appId: 'fixture', path: 'cmd.exe' }, '打开 测试应用'],
      ['shell', 'shell', {}, '打开 测试应用'],
      ['ambiguous', 'open_app', { appId: 'fixture' }, '随便打开一个应用'],
      ['extra', 'system_status', { command: 'anything' }, '电脑状态']
    ] as const) assert.equal((await run(id, name, args, text)).status, 'failed')
    assert.equal(launched, 1)
    store.saveApp({ ...store.apps()[0], approved: false })
    assert.equal((await run('revoked', 'open_app', { appId: 'fixture' })).status, 'waiting')
    store.saveApp({ ...store.apps()[0], approved: true })
    writeFileSync(path, 'changed target content')
    assert.equal((await run('changed', 'open_app', { appId: 'fixture' })).status, 'failed')
    assert.equal(store.apps()[0].approved, false)
    store.saveApp({ ...store.apps()[0], approved: true, fingerprint: await fingerprint(path) })
    const failed = new ToolExecutor(store, async () => { throw new Error('private exception') }, () => {})
    const failure = await failed.execute('failed', 'session', 'open_app', { appId: 'fixture' }, new AbortController().signal, '打开 fixture')
    assert.equal(failure.status, 'failed'); assert.ok(!failure.result.includes('private'))
    const aborted = new AbortController(); aborted.abort()
    assert.equal((await executor.execute('cancelled', 'session', 'open_app', { appId: 'fixture' }, aborted.signal, '打开 fixture')).status, 'cancelled')
    const slow = new ToolExecutor(store, () => new Promise(() => {}), () => {}, 10)
    assert.equal((await slow.execute('timeout', 'session', 'system_status', {}, new AbortController().signal, '电脑状态')).status, 'timeout')
    assert.equal((await slow.execute('uncertain', 'session', 'open_app', { appId: 'fixture' }, new AbortController().signal, '打开 fixture')).status, 'uncertain')
    store.saveTool({ id: 'crash', sessionId: 'session', name: 'open_app', target: 'fixture', status: 'running', result: '', createdAt: new Date().toISOString() })
    store.close(); store = new Store(db)
    assert.equal(store.tool('crash')!.status, 'uncertain')
    const restored = new ToolExecutor(store, async () => { launched++ }, () => {})
    assert.equal((await restored.execute('crash', 'session', 'open_app', { appId: 'fixture' }, new AbortController().signal, '打开 fixture')).status, 'uncertain')
    assert.equal(launched, 1)
  } finally { store.close(); assert.ok(dir.startsWith(join(tmpdir(), 'changli-'))); rmSync(dir, { recursive: true, force: true }) }
})

test('模型工具往返、手动重试不重复启动、最新记忆注入与工具轮数上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'changli-loop-'))
  const path = join(dir, 'fixture.exe'); writeFileSync(path, 'stub-only')
  const store = new Store(':memory:')
  let attempts = 0, launched = 0, mode = 'open'
  const prompts: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const payload = JSON.parse(body); prompts.push(payload.messages[0].content)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (mode === 'plain') { res.end('data: {"choices":[{"delta":{"content":"测试文字"}}]}\n\ndata: [DONE]\n\n'); return }
    const hasResult = payload.messages.some((m: { role: string }) => m.role === 'tool')
    if (!hasResult || mode === 'limit') {
      const call = { index: 0, id: 'call_' + (++attempts), type: 'function', function: { name: mode === 'limit' ? 'system_status' : 'open_app', arguments: mode === 'limit' ? '{}' : '{"appId":"fixture"}' } }
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + '\n\ndata: [DONE]\n\n')
    } else if (attempts === 1) res.end('data: {"choices":[{"delta":{"content":"断流前"}}]}\n\n')
    else res.end('data: {"choices":[{"delta":{"content":"基于执行器结果回复"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const settings: Settings = { mode: 'chat-completions', model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hasKey: false }
  const chat = new Chat(store, '人设', () => settings, () => '', () => {})
  chat.executor = new ToolExecutor(store, async () => { launched++ }, () => {})
  try {
    store.saveApp({ id: 'fixture', name: '测试应用', target: path, approved: true, fingerprint: await fingerprint(path) })
    chat.send('打开 测试应用'); await chat.active?.task
    assert.equal(chat.snapshot().messages.at(-1)?.status, 'failed'); assert.equal(launched, 1)
    chat.retry(chat.snapshot().messages.at(-1)!.id); await chat.active?.task
    assert.equal(chat.snapshot().messages.at(-1)?.status, 'complete'); assert.equal(launched, 1)
    assert.equal(store.memories().length, 0)
    mode = 'plain'; store.saveMemory({ content: '偏好短答', category: 'fact' })
    const id = store.memories()[0].id
    chat.send('普通聊天'); await chat.active?.task; assert.ok(prompts.at(-1)!.includes('偏好短答'))
    store.saveMemory({ id, content: '偏好详细答复', category: 'fact' })
    chat.send('下一轮'); await chat.active?.task; assert.ok(!prompts.at(-1)!.includes('偏好短答')); assert.ok(prompts.at(-1)!.includes('偏好详细答复'))
    store.deleteMemory(id); chat.send('记住，尚未确认'); await chat.active?.task; assert.ok(!prompts.at(-1)!.includes('偏好详细答复')); assert.equal(store.memories().length, 0)
    mode = 'limit'; chat.send('电脑状态'); await chat.active?.task
    assert.equal(chat.snapshot().messages.at(-1)!.status, 'failed'); assert.match(chat.snapshot().messages.at(-1)!.error, /上限/)
    assert.equal(store.tools().filter(t => t.name === 'system_status').length, 3)
    chat.send('查询电脑状态')
    await new Promise(resolve => setTimeout(resolve, 80)); await chat.stop()
    assert.equal(chat.snapshot().messages.at(-1)!.status, 'stopped')
    assert.equal(store.tools()[0].status, 'cancelled')
  } finally { store.close(); await new Promise<void>(resolve => server.close(() => resolve())); assert.ok(dir.startsWith(join(tmpdir(), 'changli-'))); rmSync(dir, { recursive: true, force: true }) }
})
