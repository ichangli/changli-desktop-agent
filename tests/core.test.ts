import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:http'
import { Store } from '../src/main/store'
import { Chat } from '../src/main/chat'
import { runtimePrompt, stream, validateEndpoint } from '../src/main/model'
import type { Settings } from '../src/shared/types'

const demo: Settings = { mode: 'demo', endpoint: '', model: '', hasKey: false }
test('DeepSeek 官方接口显式禁用思考，其他供应商不附加专属参数（网络桩）', async () => {
  const original = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string))
    return new Response('data: {"choices":[{"delta":{"content":"测试"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  try {
    for (const endpoint of ['https://api.deepseek.com/chat/completions', 'https://example.com/v1/chat/completions']) {
      for await (const _chunk of stream({ ...demo, mode: 'chat-completions', model: 'deepseek-flash', endpoint }, '', [], new AbortController().signal)) { /* 收集请求格式 */ }
    }
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
    assert.equal(bodies[1].thinking, undefined)
  } finally { globalThis.fetch = original }
})
test('会话顺序、选择及崩溃恢复持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changli-core-'))
  try {
    let store = new Store(join(dir, 'test.sqlite'))
    const a = store.create(); store.add(a, 'user', '第一段', 'complete')
    const b = store.create(); store.add(b, 'user', '第二段', 'complete'); store.add(b, 'assistant', '未完', 'generating')
    store.close(); store = new Store(join(dir, 'test.sqlite'))
    assert.equal(store.get('selected'), b); assert.equal(store.conversations().length, 2)
    assert.equal(store.messages(a)[0].content, '第一段')
    assert.deepEqual(store.messages(b).map(m => m.status), ['complete', 'interrupted'])
    store.close()
  } finally { assert.ok(dir.startsWith(join(tmpdir(), 'changli-core-'))); rmSync(dir, { recursive: true, force: true }) }
})
test('停止后内容不追加，下一轮可发送，重试不重复用户消息', async () => {
  const store = new Store(':memory:')
  const chat = new Chat(store, 'prompt', () => demo, () => '', () => {})
  chat.send('你好'); await delay(120)
  assert.ok(chat.snapshot().messages.at(-1)!.content.length > 0)
  await chat.stop(); const content = chat.snapshot().messages.at(-1)!.content
  await delay(80); assert.equal(chat.snapshot().messages.at(-1)!.content, content)
  assert.equal(chat.snapshot().messages.at(-1)!.status, 'stopped')
  chat.retry(chat.snapshot().messages.at(-1)!.id); await chat.stop()
  assert.equal(chat.snapshot().messages.filter(m => m.role === 'user').length, 1)
  chat.send('下一条'); await chat.stop('interrupted')
  assert.equal(chat.snapshot().messages.at(-1)!.status, 'interrupted'); store.close()
})
test('非法输入、缺少配置明确失败，不静默重试', async () => {
  const store = new Store(':memory:')
  const chat = new Chat(store, '', () => ({ ...demo, mode: 'chat-completions' }), () => '', () => {})
  assert.throws(() => chat.send(' ')); assert.throws(() => chat.select('unknown'))
  chat.send('测试'); await chat.active?.task
  assert.equal(chat.snapshot().messages.at(-1)!.status, 'failed')
  assert.equal(chat.snapshot().messages.length, 2); store.close()
})
test('人设仅提取运行时段；限制远端明文与 URL 凭据', () => {
  assert.equal(runtimePrompt('说明\n## 运行时角色提示\n角色\n## 开发验证样例\n虚构'), '## 运行时角色提示\n角色')
  assert.throws(() => runtimePrompt('无分段'))
  for (const url of ['http://example.com/api', 'https://user:secret@example.com/api', 'https://example.com/api?key=secret', 'file:///test']) assert.throws(() => validateEndpoint(url))
  assert.equal(validateEndpoint('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions')
})
test('SSE 分块 UTF-8、错误凭据、断流不冒充完成或暴露服务响应', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(401); res.end('SECRET_PRIVATE_RESPONSE'); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"长离"}}]}\r\n\r\n')
    res.write(bytes.subarray(0, 44)); res.write(bytes.subarray(44))
    res.end(req.url === '/cut' ? '' : 'data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  async function collect(path: string) {
    let output = ''
    for await (const text of stream({ ...demo, mode: 'chat-completions', model: 'fake', endpoint: `http://127.0.0.1:${port}${path}` }, 'SECRET_KEY', [], new AbortController().signal)) output += text
    return output
  }
  try {
    assert.equal(await collect('/ok'), '长离')
    await assert.rejects(collect('/bad'), error => error instanceof Error && error.message.includes('401') && !error.message.includes('SECRET'))
    await assert.rejects(collect('/cut'), /提前结束/)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
