import type { UpdateInfo, PublishedRelease } from '../shared/types'

export const releasesPage = 'https://github.com/ichangli/changli-desktop-agent/releases'
export const releasesApi = 'https://api.github.com/repos/ichangli/changli-desktop-agent/releases?per_page=20'
function versionParts(value: string) {
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if (!match || value.length > 100) throw new Error('版本号格式无效。')
  const numbers = match.slice(1, 4).map(Number), pre = match[4]?.split('.') ?? []
  if (numbers.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p.startsWith('0')))) throw new Error('版本号格式无效。')
  return { numbers, pre }
}
export function compareVersions(a: string, b: string) {
  const x = versionParts(a), y = versionParts(b)
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] > y.numbers[i] ? 1 : -1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === q) continue
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return p.length !== q.length ? (p.length > q.length ? 1 : -1) : p > q ? 1 : -1
    if (pn !== qn) return pn ? -1 : 1
    return p > q ? 1 : -1
  }
  return 0
}
export function selectRelease(value: unknown): PublishedRelease | null {
  if (!Array.isArray(value)) throw new Error('GitHub 返回的版本信息格式无效。')
  const releases: PublishedRelease[] = []
  for (const item of value) {
    if (!item || item.draft !== false || typeof item.prerelease !== 'boolean' || typeof item.tag_name !== 'string' || !item.tag_name.startsWith('v')) continue
    try { versionParts(item.tag_name) } catch { continue }
    if (!Array.isArray(item.assets) || !item.assets.some((a: any) => a?.state === 'uploaded' && typeof a.name === 'string' && /\.(exe|zip)$/i.test(a.name))) continue
    releases.push({ tag: item.tag_name, version: item.tag_name.slice(1), prerelease: item.prerelease,
      publishedAt: typeof item.published_at === 'string' && Number.isFinite(Date.parse(item.published_at)) ? item.published_at : '',
      notes: typeof item.body === 'string' ? item.body.slice(0, 20000) : '' })
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}
async function readJson(response: Response) {
  if (!response.body) throw new Error('GitHub 未返回版本信息。')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error('GitHub 版本信息超过大小限制。')
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('GitHub 返回的版本信息格式无效。') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export function createUpdateService(currentVersion: string, request: typeof fetch, open: (url: string) => Promise<unknown>) {
  let info: UpdateInfo = { currentVersion, checkedAt: '', status: 'idle', release: null }
  let running: Promise<UpdateInfo> | null = null
  return {
    info: () => info,
    check() {
      if (running) return running
      running = Promise.resolve().then(async () => {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000)
        info = { currentVersion, checkedAt: '', status: 'checking', release: null }
        try {
          const response = await request(releasesApi, { signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } })
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            if ([403, 429].includes(response.status)) throw new Error('GitHub 暂时限制了请求，请稍后再试，或直接前往下载页。')
            throw new Error('无法获取 GitHub 版本信息，请稍后重试，或直接前往下载页。')
          }
          const release = selectRelease(await readJson(response))
          info = { currentVersion, checkedAt: new Date().toISOString(), release, status: !release ? 'empty' : compareVersions(release.version, currentVersion) > 0 ? 'available' : 'current' }
          return info
        } catch (error) {
          info = { currentVersion, checkedAt: '', status: 'error', release: null }
          if (controller.signal.aborted) throw new Error('检查更新超过 15 秒，请重试或直接前往下载页。')
          if (error instanceof Error && /^(GitHub|无法获取 GitHub)/.test(error.message)) throw error
          throw new Error('无法连接 GitHub，请检查网络后重试，或直接前往下载页。')
        } finally { clearTimeout(timeout); running = null }
      })
      return running
    },
    async openPage() {
      // 不接收页面/远端提供的 URL，只打开固定仓库的 Release 页面。
      const tag = info.release?.tag
      const url = tag ? releasesPage + '/tag/' + encodeURIComponent(tag) : releasesPage
      try { await open(url) } catch { throw new Error('无法打开浏览器，请手动访问项目的 GitHub Releases。') }
    }
  }
}
