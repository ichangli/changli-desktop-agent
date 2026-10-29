import { setTimeout as delay } from 'node:timers/promises'
import type { Settings } from '../shared/types'

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
export function validateEndpoint(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('请填写完整的 Chat Completions 接口地址。') }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('接口须使用 HTTPS（本机可用 HTTP），且不能包含凭据、查询参数或片段。')
  return url.toString()
}
export async function* stream(settings: Settings, key: string, messages: ModelMessage[], signal: AbortSignal, toolOptions?: { definitions: unknown[]; receive: (calls: ToolCall[]) => void }): AsyncGenerator<string> {
  if (settings.mode === 'demo') {
    const text = '【模拟回复 · 未连接模型】\n长离在这里。这段文字用于检查逐字显示、停止和会话保存。真实的人设对话需要先在设置中连接模型。\n\n你刚才说：' + messages.at(-1)?.content
    for (const char of text) { await delay(22, undefined, { signal }); yield char }
    return
  }
  const endpoint = validateEndpoint(settings.endpoint)
  if (!settings.model.trim()) throw new Error('尚未填写模型名称，请先保存连接设置。')
  let response: Response
  try {
    response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: settings.model, messages, stream: true,
        // DeepSeek 默认思考模式要求完整回传 reasoning_content；当前适配只用非思考模式。
        ...(new URL(endpoint).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
        ...(toolOptions ? { tools: toolOptions.definitions } : {}) }) })
  } catch { signal.throwIfAborted(); throw new Error('无法连接模型服务，请检查接口、网络及服务状态。') }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`模型服务返回 HTTP ${response.status}。请检查认证、模型与服务配额。`)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务未返回所需的 SSE 流，请核对协议。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let count = 0
  const calls: ToolCall[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 1_000_000) throw new Error('模型流事件过大，已停止。')
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          if (!count && !calls.length) throw new Error('模型没有返回文字。')
          for (let i = 0; i < calls.length; i++) if (!calls[i]) throw new Error('工具调用序号不连续。')
          if (calls.some(c => !c || !c.id || !c.function.name)) throw new Error('工具调用格式不完整。')
          toolOptions?.receive(calls); return
        }
        let event
        try { event = JSON.parse(data) } catch { throw new Error('模型流格式无效。') }
        if (event.error) throw new Error('模型服务报告生成失败。')
        const choice = event.choices?.[0]
        if (choice?.delta?.tool_calls) {
          if (!toolOptions) throw new Error('此请求未开放工具。')
          for (const item of choice.delta.tool_calls) {
            if (!Number.isInteger(item.index) || item.index < 0 || item.index >= 6) throw new Error('单轮工具调用过多或序号无效。')
            const call = calls[item.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
            if (typeof item.id === 'string') call.id += item.id
            if (typeof item.function?.name === 'string') call.function.name += item.function.name
            if (typeof item.function?.arguments === 'string') call.function.arguments += item.function.arguments
            if (call.id.length > 100 || call.function.name.length > 80 || call.function.arguments.length > 4000) throw new Error('工具调用超过参数上限。')
          }
        }
        const text = choice?.delta?.content
        if (typeof text === 'string' && text) { count += text.length; if (count > 100_000) throw new Error('回复达到长度上限，已停止。'); yield text }
      }
      if (done) throw new Error('模型连接提前结束，回复可能不完整，请手动重试。')
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function runtimePrompt(file: string) {
  const start = file.indexOf('## 运行时角色提示')
  const end = file.indexOf('## 开发验证样例')
  if (start < 0 || end <= start) throw new Error('人设文件缺少运行时分段。')
  return file.slice(start, end).trim()
}
