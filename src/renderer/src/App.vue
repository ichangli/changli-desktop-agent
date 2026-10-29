<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import type { Snapshot, SettingsInput, Status, MemoryInput, Workspace, Memory, AllowedApp } from '../../shared/types'
const api = window.changli
const state = ref<Snapshot>()
const page = ref<'chat' | 'settings' | 'memory' | 'tools'>('chat')
const workspace = ref<Workspace>({ memories: [], apps: [], tools: [] })
const memoryForm = ref<MemoryInput>({ content: '', category: 'fact' })
const deleting = ref('')
const editingAppId = ref(''), appNameDraft = ref('')
function editAppName(app: AllowedApp) { editingAppId.value = app.id; appNameDraft.value = app.name }
function appName(id: string) { return workspace.value.apps.find(app => app.id === id)?.name ?? (id ? '已配置应用' : '') }
const title = computed(() => ({ chat: '与长离对话', settings: '连接设置', memory: '明确记忆', tools: '电脑工具' })[page.value])
const proposal = computed(() => {
  const message = state.value?.messages.findLast(m => m.role === 'user')
  if (!message || workspace.value.memories.some(m => m.source === '会话消息：' + message.id)) return null
  const match = message.content.match(/^记住[，,:：\s]*(.+)$/s)
  return match ? { content: match[1], source: '会话消息：' + message.id } : null
})
function editMemory(m?: Memory) { memoryForm.value = m ? { ...m } : { content: '', category: 'fact' } }
function offerMemory() { if (proposal.value) { memoryForm.value = { ...proposal.value, category: 'fact' }; page.value = 'memory' } }
async function tool(name: string, args: unknown) { await action(async () => { workspace.value = await api.runTool({ id: crypto.randomUUID(), name, args }) }) }
function formatResult(name: string, result: string) {
  if (name !== 'system_status' || !result.startsWith('{')) return result || '正在执行…'
  try {
    const data = JSON.parse(result), gib = (n: number) => (n / 1024 ** 3).toFixed(2)
    return `采样时间：${new Date(data.sampledAt).toLocaleString('zh-CN')}（采样窗口 ${data.sampleWindowMs} ms）\nCPU 使用率：${data.cpu.usagePercent === null ? '读取不可用' : data.cpu.usagePercent + '%'}\n内存：${gib(data.memory.usedBytes)} / ${gib(data.memory.totalBytes)} GiB（${data.memory.usagePercent}%）\n显卡与 CPU 温度：当前版本不支持\n${data.note}`
  } catch { return '状态结果无法解析，请重新查询。' }
}
function onEnter(event: KeyboardEvent) { if (event.isComposing) return; event.preventDefault(); if (!state.value?.activeId && !pending.value && draft.value.trim()) void send() }
const draft = ref(''), notice = ref(''), pending = ref(false), testing = ref(false)
const feed = ref<HTMLElement>()
const form = ref<SettingsInput>({ mode: 'demo', endpoint: '', model: '', key: '', clearKey: false })
const deepseekEndpoint = 'https://api.deepseek.com/chat/completions'
const deepseekModel = 'deepseek-flash'
function useDeepseekPreset() {
  form.value.mode = 'chat-completions'
  form.value.endpoint = deepseekEndpoint
  form.value.model = deepseekModel
}
const labels: Record<Status, string> = { generating: '正在回复', complete: '已完成', stopped: '已停止', interrupted: '已中断', failed: '失败' }
async function apply(value: Snapshot) { state.value = value; workspace.value = await api.workspace(); await nextTick(); if (feed.value) feed.value.scrollTop = feed.value.scrollHeight }
async function action(fn: () => Promise<unknown>) {
  notice.value = ''; pending.value = true
  try { await fn() } catch (e) { notice.value = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '操作失败，请重试。' }
  finally { pending.value = false }
}
async function send() { const text = draft.value; await action(async () => { await api.send(text); draft.value = '' }) }
function openSettings() { if (!state.value) return; form.value = { ...state.value.settings, key: '', clearKey: false }; page.value = 'settings'; notice.value = '' }
let unsubscribe: (() => void) | undefined
onMounted(() => { unsubscribe = api.onChange(apply); void action(async () => apply(await api.snapshot())) })
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="shell">
    <aside>
      <div class="brand"><span class="seal">离</span><div>长离<span class="subtitle">桌面助手 · v0.1</span></div></div>
      <button class="new" :disabled="pending" @click="action(async () => { await apply(await api.create()); page = 'chat' })">＋ 新的对话</button>
      <div class="section-label">对话记录</div>
      <nav><button v-for="c in state?.conversations" :key="c.id" :class="{ selected: state?.selectedId === c.id && page === 'chat' }" @click="action(async () => { await apply(await api.select(c.id)); page = 'chat' })">{{ c.title }}</button></nav>
      <div class="aside-bottom"><div class="local">● 会话保存在本机</div><button class="settings-link" @click="page = 'memory'">◇ 明确记忆</button><button class="settings-link" @click="page = 'tools'">⌘ 电脑工具</button><button class="settings-link" @click="openSettings">⚙ 连接设置</button></div>
    </aside>
    <main>
      <header><div><h1>{{ title }}</h1><p>{{ page === 'chat' ? '片刻闲谈，亦可慢慢说来。' : '由你决定保存的内容与允许的操作' }}</p></div><span class="mode">{{ state?.settings.mode === 'chat-completions' ? '模型接口 · ' + state.settings.model : '模拟模式 · 未连接模型' }}</span></header>
      <div v-if="notice" class="notice" role="alert">{{ notice }}</div>
      <div v-if="state?.fault" class="notice" role="alert">{{ state.fault }}</div>
      <template v-if="page === 'chat'">
        <div v-if="state?.settings.mode === 'demo'" class="demo">当前回复由本地模拟器生成，仅用于验证交互和保存。可在连接设置中配置真实模型。</div>
        <div v-if="proposal" class="demo">检测到明确记忆请求，请确认类别和内容后保存。<button @click="offerMemory">确认记忆内容</button></div>
        <div ref="feed" class="feed" aria-live="polite">
          <div v-if="!state?.messages.length" class="welcome"><div class="large-seal">离</div><h2>此刻，有什么想说的？</h2><p>从一句问候开始，或聊聊今天的见闻。</p><span>文字聊天 · 本地记录</span></div>
          <article v-for="m in state?.messages" :key="m.id" :class="['message', m.role]">
            <div class="author">{{ m.role === 'user' ? '你' : '长离' }}<time>{{ new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></div>
            <div class="bubble">{{ m.content || (m.status === 'generating' ? '正在等待回复…' : '未收到文字') }}</div>
            <div v-if="m.role === 'assistant'" :class="['status', m.status]">{{ labels[m.status] }}<span v-if="m.error"> · {{ m.error }}</span><button v-if="m.id === state?.messages.at(-1)?.id && ['stopped','failed','interrupted'].includes(m.status)" :disabled="!!state.activeId || pending" @click="action(() => api.retry(m.id))">重试此回复</button></div>
          </article>
          <div v-for="t in workspace.tools.filter(t => t.sessionId === state?.selectedId).slice(0, 6).reverse()" :key="t.id" class="record"><strong>工具 · {{ t.name === 'open_app' ? '打开应用' : t.name === 'system_status' ? '查询电脑状态' : t.name }} {{ appName(t.target) }}</strong><span class="tool-status">{{ ({ waiting: '等待授权', running: '运行中', success: '成功', failed: '失败', cancelled: '取消', timeout: '超时', uncertain: '结果不确定' })[t.status] }}</span><pre>{{ formatResult(t.name, t.result) }}</pre></div>
        </div>
        <form class="composer" @submit.prevent="send"><textarea v-model="draft" aria-label="消息" maxlength="10000" placeholder="与长离说些什么…" :disabled="pending" @keydown.enter.exact="onEnter"></textarea><div class="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button v-if="state?.activeId" type="button" class="primary" :disabled="pending" @click="action(() => api.stop())">停止生成</button><button v-else class="primary" :disabled="pending || !draft.trim() || !state">发送 ↑</button></div></form>
        <footer>记忆由你确认保存 · 操作以电脑工具记录为准</footer>
      </template>
      <section v-else-if="page === 'settings'" class="settings-panel">
        <h2>模型连接</h2><p>云端模式会将近期消息、选中记忆、相关工具结果、已配置应用的名称/ID/授权状态与角色提示发送给你配置的服务；不发送应用启动路径。本地模拟不发网络请求。</p>
        <form @submit.prevent="action(async () => { await apply(await api.saveSettings({ ...form })); form.key = ''; form.clearKey = false; notice = '连接设置已保存。' })">
          <div class="buttons"><button type="button" :disabled="pending || !!state?.activeId" @click="useDeepseekPreset">使用 DeepSeek 预设</button></div>
          <p class="hint">自动填好运行模式、接口地址与模型名称，填写 API Key 后保存即可。也可从下拉建议中选择，或手动填写其他服务。</p>
          <label>运行模式<select v-model="form.mode"><option value="demo">本地模拟（未连接模型）</option><option value="chat-completions">Chat Completions / SSE</option></select></label>
          <label>完整接口地址<input v-model="form.endpoint" list="model-endpoints" placeholder="选择预设或填写完整接口地址" autocomplete="off"></label>
          <datalist id="model-endpoints"><option :value="deepseekEndpoint">DeepSeek 官方</option></datalist>
          <label>模型名称<input v-model="form.model" list="model-names" placeholder="选择预设或填写模型名称" autocomplete="off"></label>
          <datalist id="model-names"><option :value="deepseekModel"></option></datalist>
          <label>API Key<input v-model="form.key" type="password" :placeholder="state?.settings.hasKey ? '已保存；留空保留原密钥' : '未保存密钥；本机服务可不填写'" autocomplete="new-password"></label>
          <label class="checkbox"><input v-model="form.clearKey" type="checkbox">清除原有密钥</label>
          <p class="hint">凭据经 Windows 加密后保存在本机，页面不会读回密钥。更换接口地址会清除旧密钥；如需继续使用，请重新填写。</p>
          <div class="buttons"><button class="primary" :disabled="pending || !!state?.activeId">保存设置</button><button type="button" :disabled="pending || testing || !!state?.activeId" @click="action(async () => { testing = true; try { notice = await api.testConnection() } finally { testing = false } })">{{ testing ? '检查中…' : '检查已保存的连接' }}</button><button type="button" @click="page = 'chat'">返回对话</button></div>
          <p class="hint">连接检查会发送一次简短请求，可能产生服务费用。本适配器要求单行 data 事件的 SSE 文本流，不承诺所有兼容接口均可用。</p>
        </form>
      </section>
      <section v-else-if="page === 'memory'" class="settings-panel">
        <h2>只记住你明确交代的事</h2><p>普通聊天不会自动创建记忆。不同内容会分别保存；已有偏好有冲突时，请先检查列表并明确编辑原条目。删除记忆不会删除来源聊天。下一轮请求最多使用最近 8 条、合计 4000 字符。</p>
        <form @submit.prevent="action(async () => { workspace = await api.saveMemory({ ...memoryForm }); editMemory(); notice = '记忆已保存到本机。' })">
          <label>记忆内容<textarea v-model="memoryForm.content" maxlength="1000" required aria-label="记忆内容" placeholder="例如：技术问题希望先给简短结论"></textarea></label>
          <label>记忆类别<select v-model="memoryForm.category"><option value="fact">现实事实 / 偏好</option><option value="roleplay">角色互动约定（非现实事实）</option></select></label>
          <div class="buttons"><button class="primary" :disabled="pending || !memoryForm.content.trim()">{{ memoryForm.id ? '保存修改' : '保存新记忆' }}</button><button type="button" @click="editMemory()">清空表单</button><button type="button" @click="page = 'chat'">返回对话</button></div>
        </form>
        <div class="record" v-for="m in workspace.memories" :key="m.id"><strong>{{ m.category === 'fact' ? '现实事实 / 偏好' : '角色互动约定' }}</strong><p class="record-content">{{ m.content }}</p><small>来源：{{ m.source }} · 更新 {{ new Date(m.updatedAt).toLocaleString('zh-CN') }}</small><div class="buttons"><button @click="editMemory(m)">编辑</button><button v-if="deleting !== m.id" @click="deleting = m.id">删除</button><template v-else><button @click="action(async () => { workspace = await api.deleteMemory(m.id); deleting = ''; if (memoryForm.id === m.id) editMemory() })">确认删除这条记忆</button><button @click="deleting = ''">保留</button></template></div></div>
        <p v-if="!workspace.memories.length">尚未保存长期记忆。</p>
      </section>
      <section v-else class="settings-panel">
        <h2>真实状态与获准应用</h2><p>CPU 与内存按需采样，不持续上传。GPU 与温度当前不支持。应用启动只接受你选择的 .exe 文件；首次保存后需单独授权，可随时撤销。模型不能提交路径或命令。</p>
        <div class="buttons"><button class="primary" :disabled="pending || !!state?.activeId" @click="tool('system_status', {})">查询电脑状态</button><button v-if="pending || state?.activeId" @click="api.stop()">停止当前请求</button><button @click="page = 'chat'">返回对话</button></div>
        <div class="app-add"><h2>添加常用应用</h2><p>选择程序后自动带出名称，确认路径并允许启动即可。</p><button class="primary" :disabled="pending" @click="action(async () => { workspace = await api.configureApp() })">添加应用</button></div>
        <div class="record" v-for="a in workspace.apps" :key="a.id">
          <strong>{{ a.name }}</strong><p>{{ a.target }}</p><small>{{ a.approved ? '已授权，明确请求时可启动' : '未授权，启动请求会被拦截' }} · 对长离说“打开{{ a.name }}”</small>
          <form v-if="editingAppId === a.id" @submit.prevent="action(async () => { workspace = await api.renameApp({ id: a.id, name: appNameDraft }); editingAppId = '' })"><label>应用名称<input v-model="appNameDraft" aria-label="应用名称" maxlength="80" required></label><div class="buttons"><button :disabled="pending || !appNameDraft.trim()">保存名称</button><button type="button" :disabled="pending" @click="editingAppId = ''">取消</button></div></form>
          <div class="buttons"><button :disabled="pending" @click="action(async () => { workspace = await api.grantApp({ id: a.id, approved: !a.approved }) })">{{ a.approved ? '撤销授权' : '允许启动此应用' }}</button><button :disabled="pending || !!state?.activeId" @click="tool('open_app', { appId: a.id })">打开此应用</button><button v-if="editingAppId !== a.id" :disabled="pending" @click="editAppName(a)">修改名称</button></div>
        </div>
        <h2>执行记录</h2><p>保留并展示最近 100 条。重启不会重放调用；已提交系统的启动不能保证撤回。</p>
        <div class="record" v-for="t in workspace.tools" :key="t.id"><strong>{{ t.name === 'system_status' ? '查询电脑状态' : t.name === 'open_app' ? '打开应用' : t.name }} {{ appName(t.target) }}</strong><span class="tool-status">{{ ({ waiting: '等待授权', running: '运行中', success: '成功', failed: '失败', cancelled: '取消', timeout: '超时', uncertain: '结果不确定' })[t.status] }}</span><pre>{{ formatResult(t.name, t.result) }}</pre><small>{{ new Date(t.createdAt).toLocaleString('zh-CN') }}</small></div>
      </section>
    </main>
  </div>
</template>
