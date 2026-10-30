<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import type { Snapshot, SettingsInput, Status, MemoryInput, Workspace, Memory, AllowedApp, SearchHit, RestorePreview, DesktopPreferences, UpdateInfo } from '../../shared/types'
const api = window.changli
const state = ref<Snapshot>()
const page = ref<'chat' | 'settings' | 'memory' | 'tools' | 'data' | 'desktop' | 'updates'>('chat')
const workspace = ref<Workspace>({ memories: [], apps: [], tools: [] })
const memoryForm = ref<MemoryInput>({ content: '', category: 'fact' })
const deleting = ref('')
const updateInfo = ref<UpdateInfo>()
async function checkUpdates() { await action(async () => { try { updateInfo.value = await api.checkUpdates() } finally { updateInfo.value = await api.updateInfo() } }) }

const desktopPreferences = ref<DesktopPreferences>({ closeAction: 'quit', trayAvailable: false })
const quitting = ref(false)
const searchQuery = ref(''), searchResults = ref<SearchHit[] | null>(null), matchedMessage = ref('')
const conversationTitle = ref(''), editingConversation = ref(false), deletingConversation = ref(false)
const restorePreview = ref<RestorePreview | null>(null)
async function searchHistory() { await action(async () => { searchResults.value = searchQuery.value.trim() ? await api.searchConversations(searchQuery.value) : null }) }
function clearSearch() { searchQuery.value = ''; searchResults.value = null; matchedMessage.value = '' }
async function openConversation(id: string, messageId?: string | null) {
  await apply(await api.select(id)); page.value = 'chat'; editingConversation.value = false; deletingConversation.value = false
  matchedMessage.value = messageId ?? ''
  await nextTick()
  if (matchedMessage.value) document.getElementById('message-' + matchedMessage.value)?.scrollIntoView({ block: 'center' })
}
async function refreshSearch() { if (searchResults.value !== null) searchResults.value = await api.searchConversations(searchQuery.value) }

const editingAppId = ref(''), appNameDraft = ref('')
function editAppName(app: AllowedApp) { editingAppId.value = app.id; appNameDraft.value = app.name }
function appName(id: string) { return workspace.value.apps.find(app => app.id === id)?.name ?? (id ? '已配置应用' : '') }
const settingsTabs = [{ id: 'settings', label: '模型连接' }, { id: 'desktop', label: '窗口与托盘' }, { id: 'data', label: '数据与备份' }, { id: 'updates', label: '关于与更新' }] as const
const inSettings = computed(() => settingsTabs.some(tab => tab.id === page.value))
function switchSettings(id: typeof settingsTabs[number]['id']) { page.value = id; notice.value = ''; quitting.value = false }
async function tabKey(event: KeyboardEvent, index: number) {
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % settingsTabs.length
  else if (event.key === 'ArrowLeft') next = (index + settingsTabs.length - 1) % settingsTabs.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = settingsTabs.length - 1
  else return
  event.preventDefault(); switchSettings(settingsTabs[next].id); await nextTick(); document.getElementById('settings-tab-' + settingsTabs[next].id)?.focus()
}
const title = computed(() => inSettings.value ? '设置' : ({ chat: '与长离对话', settings: '连接设置', memory: '明确记忆', tools: '电脑工具', data: '数据管理', desktop: '桌面设置', updates: '版本更新' })[page.value])
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
async function openSettings() {
  if (!state.value) return
  await action(async () => {
    desktopPreferences.value = await api.desktopPreferences()
    updateInfo.value = await api.updateInfo()
    form.value = { ...state.value!.settings, key: '', clearKey: false }
    quitting.value = false; page.value = 'settings'
  })
}
let unsubscribe: (() => void) | undefined
onMounted(() => { void api.updateInfo().then(value => { updateInfo.value = value }); unsubscribe = api.onChange(apply); void action(async () => apply(await api.snapshot())) })
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="shell">
    <aside>
      <div class="brand"><span class="seal">离</span><div>长离<span class="subtitle">桌面助手 · {{ updateInfo?.currentVersion ? 'v' + updateInfo.currentVersion : '读取版本…' }}</span></div></div>
      <button class="new" :disabled="pending" @click="action(async () => { await apply(await api.create()); page = 'chat'; editingConversation = false; deletingConversation = false; matchedMessage = '' })">＋ 新的对话</button>
      <div class="section-label">对话记录</div>
      <form class="history-search" @submit.prevent="searchHistory"><input v-model="searchQuery" maxlength="200" aria-label="搜索历史" placeholder="搜索名称或聊天内容"><button :disabled="pending">搜索</button><button v-if="searchResults !== null" type="button" @click="clearSearch">清除</button></form>
      <p v-if="searchResults !== null" class="search-summary">找到 {{ searchResults.length }} 段会话（最多 100 段）</p>
      <nav aria-label="对话记录"><template v-if="searchResults !== null"><button v-for="hit in searchResults" :key="hit.sessionId" @click="action(() => openConversation(hit.sessionId, hit.messageId))"><span>{{ hit.title }}</span><small>{{ hit.excerpt || '名称匹配' }}</small></button></template><template v-else><button v-for="c in state?.conversations" :key="c.id" :class="{ selected: state?.selectedId === c.id && page === 'chat' }" @click="action(() => openConversation(c.id))">{{ c.title }}</button></template></nav>
      <div class="aside-bottom" aria-label="主导航"><button class="settings-link" :class="{ selected: page === 'memory' }" :aria-current="page === 'memory' ? 'page' : undefined" @click="page = 'memory'">◇ 记忆</button><button class="settings-link" :class="{ selected: page === 'tools' }" :aria-current="page === 'tools' ? 'page' : undefined" @click="page = 'tools'">⌘ 工具</button><button aria-label="设置" class="settings-link" :class="{ selected: inSettings }" :aria-current="inSettings ? 'page' : undefined" :disabled="pending" @click="openSettings">⚙ 设置</button></div>
    </aside>
    <main>
      <header><div><h1>{{ title }}</h1><p>{{ page === 'chat' ? '片刻闲谈，亦可慢慢说来。' : '由你决定保存的内容与允许的操作' }}</p></div><span class="mode">{{ state?.settings.mode === 'chat-completions' ? '模型接口 · ' + state.settings.model : '模拟模式 · 未连接模型' }}</span></header>
      <div v-if="inSettings" class="settings-tabs" role="tablist" aria-label="设置分类"><button v-for="(tab, index) in settingsTabs" :id="'settings-tab-' + tab.id" :key="tab.id" role="tab" :aria-selected="page === tab.id" aria-controls="settings-content" :tabindex="page === tab.id ? 0 : -1" :disabled="pending" @click="switchSettings(tab.id)" @keydown="tabKey($event, index)">{{ tab.label }}</button></div>
      <div v-if="notice" class="notice" role="alert">{{ notice }}</div>
      <div v-if="state?.fault" class="notice" role="alert">{{ state.fault }}</div>
      <template v-if="page === 'chat'">
        <div class="conversation-actions">
          <form v-if="editingConversation" @submit.prevent="action(async () => { await apply(await api.renameConversation({ id: state!.selectedId, title: conversationTitle })); editingConversation = false; await refreshSearch() })"><input v-model="conversationTitle" aria-label="会话名称" maxlength="80" required><button :disabled="pending || !conversationTitle.trim()">保存名称</button><button type="button" @click="editingConversation = false">取消</button></form>
          <template v-else><strong>{{ state?.conversations.find(c => c.id === state?.selectedId)?.title }}</strong><button :disabled="pending" @click="conversationTitle = state?.conversations.find(c => c.id === state?.selectedId)?.title || ''; editingConversation = true; deletingConversation = false">重命名会话</button><button :disabled="pending || !!state?.activeId" @click="action(async () => { notice = await api.exportConversation(state!.selectedId) })">导出聊天</button><button :disabled="pending || !!state?.activeId" @click="deletingConversation = true">删除会话</button></template>
          <div v-if="deletingConversation" class="delete-confirm">删除当前会话及其工具记录？已保存的长期记忆会保留。此操作无法撤销。<button :disabled="pending || !!state?.activeId" @click="action(async () => { await apply(await api.deleteConversation(state!.selectedId)); deletingConversation = false; await refreshSearch() })">确认删除会话</button><button @click="deletingConversation = false">保留会话</button></div>
        </div>
        <div v-if="state?.settings.mode === 'demo'" class="demo">当前回复由本地模拟器生成，仅用于验证交互和保存。可在设置的“模型连接”中配置真实模型。</div>
        <div v-if="proposal" class="demo">检测到明确记忆请求，请确认类别和内容后保存。<button @click="offerMemory">确认记忆内容</button></div>
        <div ref="feed" class="feed" aria-live="polite">
          <div v-if="!state?.messages.length" class="welcome"><div class="large-seal">离</div><h2>此刻，有什么想说的？</h2><p>从一句问候开始，或聊聊今天的见闻。</p><span>文字聊天 · 本地记录</span></div>
          <article v-for="m in state?.messages" :key="m.id" :id="'message-' + m.id" :class="['message', m.role, { 'search-match': matchedMessage === m.id }]">
            <div class="author">{{ m.role === 'user' ? '你' : '长离' }}<time>{{ new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></div>
            <div class="bubble">{{ m.content || (m.status === 'generating' ? '正在等待回复…' : '未收到文字') }}</div>
            <div v-if="m.role === 'assistant'" :class="['status', m.status]">{{ labels[m.status] }}<span v-if="m.error"> · {{ m.error }}</span><button v-if="m.id === state?.messages.at(-1)?.id && ['stopped','failed','interrupted'].includes(m.status)" :disabled="!!state.activeId || pending" @click="action(() => api.retry(m.id))">重试此回复</button></div>
          </article>
          <div v-for="t in workspace.tools.filter(t => t.sessionId === state?.selectedId).slice(0, 6).reverse()" :key="t.id" class="record"><strong>工具 · {{ t.name === 'open_app' ? '打开应用' : t.name === 'system_status' ? '查询电脑状态' : t.name }} {{ appName(t.target) }}</strong><span class="tool-status">{{ ({ waiting: '等待授权', running: '运行中', success: '成功', failed: '失败', cancelled: '取消', timeout: '超时', uncertain: '结果不确定' })[t.status] }}</span><pre>{{ formatResult(t.name, t.result) }}</pre></div>
        </div>
        <form class="composer" @submit.prevent="send"><textarea v-model="draft" aria-label="消息" maxlength="10000" placeholder="与长离说些什么…" :disabled="pending" @keydown.enter.exact="onEnter"></textarea><div class="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button v-if="state?.activeId" type="button" class="primary" :disabled="pending" @click="action(() => api.stop())">停止生成</button><button v-else class="primary" :disabled="pending || !draft.trim() || !state">发送 ↑</button></div></form>
        <footer>记忆由你确认保存 · 操作以电脑工具记录为准</footer>
      </template>
      <section v-else-if="page === 'settings'" id="settings-content" class="settings-panel" role="tabpanel" :aria-labelledby="'settings-tab-' + page">
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
      <section v-else-if="page === 'updates'" id="settings-content" class="settings-panel" role="tabpanel" :aria-labelledby="'settings-tab-' + page">
        <h2>检查新版本</h2><p>当前版本：<strong>{{ updateInfo?.currentVersion }}</strong></p>
        <p>点击检查时才会连接 GitHub，读取本项目最近 20 个发布记录（含预览版）。不发送聊天、记忆、模型配置或 API 密钥。下载和替换程序由你手动完成。</p>
        <div class="buttons"><button class="primary" :disabled="pending" @click="checkUpdates">{{ pending ? '检查中…' : '检查更新' }}</button><button :disabled="pending" @click="action(() => api.openReleases())">前往 GitHub 下载</button></div>
        <div v-if="updateInfo && ['available', 'current', 'empty'].includes(updateInfo.status)" class="record" role="status"><strong>{{ updateInfo.status === 'available' ? '发现新版本' : updateInfo.status === 'current' ? '当前版本不低于已发布版本' : '暂未找到可下载的发布版本' }}</strong><p v-if="updateInfo.release">已发布版本：{{ updateInfo.release.version }} · {{ updateInfo.release.prerelease ? '预览版' : '正式版' }}<span v-if="updateInfo.release.publishedAt"> · {{ new Date(updateInfo.release.publishedAt).toLocaleString('zh-CN') }}</span></p><small>检查时间：{{ new Date(updateInfo.checkedAt).toLocaleString('zh-CN') }}</small></div>
        <div v-if="updateInfo?.release" class="record"><h2>更新说明</h2><pre>{{ updateInfo.release.notes || '该版本未提供更新说明，可前往 GitHub 查看。' }}</pre></div>
        <p>退出旧程序后，再使用新版程序。会话等数据保存在独立用户目录中，替换程序不需要删除数据目录；更新前也可以在“数据与备份”备份聊天与记忆。</p>
      </section>
      <section v-else-if="page === 'desktop'" id="settings-content" class="settings-panel" role="tabpanel" :aria-labelledby="'settings-tab-' + page">
        <h2>窗口与系统托盘</h2><p>托盘位于 Windows 任务栏通知区域，图标可能收在“隐藏的图标”中。单击或双击图标可唤回窗口，右键可显示、隐藏或退出。</p>
        <p v-if="!desktopPreferences.trayAvailable" role="status">系统托盘当前不可用，无法隐藏窗口；关闭窗口会直接退出。</p>
        <form @submit.prevent="action(async () => { desktopPreferences = await api.saveDesktopPreferences({ closeAction: desktopPreferences.closeAction }); notice = '桌面设置已保存。' })">
          <label>关闭窗口时<select v-model="desktopPreferences.closeAction" aria-label="关闭窗口时"><option value="quit">直接退出程序（默认）</option><option value="tray" :disabled="!desktopPreferences.trayAvailable">隐藏到系统托盘，继续运行</option></select></label>
          <p>隐藏到托盘后，当前回复和已授权的操作会继续执行，云端请求仍可能产生费用。重新打开程序也会唤回已有窗口。真正退出请使用下方按钮或托盘的“退出长离”。</p>
          <div class="buttons"><button class="primary" :disabled="pending">保存桌面设置</button><button type="button" :disabled="pending || !desktopPreferences.trayAvailable" @click="action(() => api.hideWindow())">隐藏到托盘</button></div>
        </form>
        <div class="buttons"><button :disabled="pending" @click="quitting = true">退出程序</button></div>
        <div v-if="quitting" class="record"><p>确认退出长离？正在生成的回复将中断，尚未提交的后续工具调用将停止，已提交系统的操作无法保证撤回。</p><div class="buttons"><button :disabled="pending" @click="action(() => api.quitApp())">确认退出程序</button><button @click="quitting = false">继续使用</button></div></div>
        <p>此设置只影响关闭窗口的行为，不会添加开机自启。每次手动启动仍显示主窗口。</p>
      </section>
      <section v-else-if="page === 'data'" id="settings-content" class="settings-panel" role="tabpanel" :aria-labelledby="'settings-tab-' + page">
        <h2>聊天与记忆备份</h2><p>会话保存在本机。聊天、记忆与设置保存在独立用户目录中。</p><p>备份包含所有会话、消息与明确记忆，以明文 JSON 保存。文件可能包含私人内容，请妥善保管。API 密钥、连接设置、应用配置与授权、工具执行记录均不包含在内。</p>
        <div class="buttons"><button :disabled="pending || !!state?.activeId" @click="action(async () => { notice = await api.backupData() })">备份聊天与记忆</button><button :disabled="pending || !!state?.activeId" @click="action(async () => { restorePreview = await api.prepareRestore() })">选择备份恢复</button></div>
        <p>恢复会新增会话副本，保留现有会话和记忆；相同类别与内容的记忆会跳过。未完成回复标为中断，不会执行历史操作。记忆总量最多 100 条，备份文件最多 50 MiB。</p>
        <div v-if="restorePreview" class="record"><h2>确认恢复</h2><p>文件包含 {{ restorePreview.conversations }} 段会话、{{ restorePreview.messages }} 条消息、{{ restorePreview.memories }} 条记忆。确认后导入；现有连接和应用授权保持不变。</p><div class="buttons"><button :disabled="pending || !!state?.activeId" @click="action(async () => { notice = await api.restoreData(restorePreview!.token); restorePreview = null; await apply(await api.snapshot()); await refreshSearch() })">确认导入副本</button><button :disabled="pending" @click="action(async () => { await api.cancelRestore(); restorePreview = null })">取消恢复</button></div></div>
        <p>删除会话不会删除明确记忆，删除记忆也不会清除来源聊天。导出单段聊天请在聊天页点击“导出聊天”，保存为 Markdown。</p>
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
