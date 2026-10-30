import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, selectRelease, createUpdateService, releasesApi, releasesPage } from '../src/main/updates'
const release = (tag = 'v0.3.0-beta.1') => ({ tag_name: tag, draft: false, prerelease: true, published_at: '2026-10-30T00:00:00Z', body: '更新说明 <script>not executed</script>', html_url: 'https://evil.example/', assets: [{ name: 'test.exe', state: 'uploaded' }] })
test('版本比较支持数字、预览序号、正式版优先及非法标签拒绝', () => {
  for (const [a, b] of [['0.10.0', '0.2.0'], ['0.2.0', '0.2.0-beta.1'], ['0.2.0-beta.10', '0.2.0-beta.2'], ['0.2.0-beta.a', '0.2.0-beta.10'], ['0.2.0-beta.1.1', '0.2.0-beta.1']]) {
    assert.equal(compareVersions(a, b), 1); assert.equal(compareVersions(b, a), -1)
  }
  assert.equal(compareVersions('v0.2.0+build.1', '0.2.0'), 0)
  for (const bad of ['1.2', '01.2.3', '0.2.0-beta.01', 'v1.0.0/../../', '999999999999999999999.0.0']) assert.throws(() => compareVersions(bad, '0.1.0'))
})
test('发布记录跳过草稿/无附件/无效标签，按版本而非返回顺序选择，截断说明', () => {
  const selected = selectRelease([release('v0.1.0'), { ...release('v9.0.0'), draft: true }, { ...release('v8.0.0'), assets: [] }, release('vBAD'), release('v0.2.0-beta.2'), { ...release('v0.2.0-beta.10'), body: 'x'.repeat(21000) }])!
  assert.equal(selected.tag, 'v0.2.0-beta.10'); assert.equal(selected.notes.length, 20000)
  assert.equal(selectRelease([]), null); assert.throws(() => selectRelease({}))
})
test('只请求固定 GitHub API，不带模型凭据；并发检查复用请求，打开链接忽略远端 URL', async () => {
  let count = 0, url = '', options: RequestInit | undefined
  const service = createUpdateService('0.2.0-beta.1', (async (input, init) => {
    count++; url = String(input); options = init
    await new Promise(resolve => setTimeout(resolve, 20))
    return new Response(JSON.stringify([release()]))
  }) as typeof fetch, async value => { url = value })
  assert.equal(service.info().status, 'idle'); assert.equal(count, 0)
  const [a, b] = await Promise.all([service.check(), service.check()])
  assert.equal(count, 1); assert.deepEqual(a, b); assert.equal(a.status, 'available')
  assert.equal(url, releasesApi); assert.equal(options!.credentials, 'omit'); assert.equal(options!.redirect, 'error')
  assert.deepEqual(Object.keys(options!.headers!).sort(), ['Accept', 'X-GitHub-Api-Version'])
  await service.openPage(); assert.equal(url, releasesPage + '/tag/v0.3.0-beta.1')
})
test('较新本地版不提示降级，空发布列表、403/429、损坏及超量响应、网络失败可重试', async () => {
  for (const [value, status] of [[[release('v0.1.0')], 'current'], [[], 'empty']] as const) {
    const service = createUpdateService('0.2.0-beta.1', (async () => new Response(JSON.stringify(value))) as typeof fetch, async () => {})
    assert.equal((await service.check()).status, status)
  }
  for (const response of [new Response('SECRET_ERROR', { status: 403 }), new Response('', { status: 429 }), new Response('SECRET_ERROR', { status: 500 }), new Response('{broken'), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    let fail = true
    const service = createUpdateService('0.2.0-beta.1', (async () => fail ? response : new Response('[]')) as typeof fetch, async () => {})
    await assert.rejects(service.check(), error => !String(error).includes('SECRET_ERROR'))
    assert.equal(service.info().status, 'error'); assert.equal(service.info().release, null)
    fail = false; assert.equal((await service.check()).status, 'empty')
  }
  const service = createUpdateService('0.1.0', (async () => { throw new Error('private network detail') }) as typeof fetch, async () => { throw new Error('private path') })
  await assert.rejects(service.check(), /无法连接 GitHub/)
  await assert.rejects(service.openPage(), /无法打开浏览器/)
})
test('检查更新 15 秒超时可恢复，不暴露底层网络信息', async () => {
  const service = createUpdateService('0.1.0', ((_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private timeout detail'))))) as typeof fetch, async () => {})
  await assert.rejects(service.check(), /超过 15 秒/)
  assert.equal(service.info().status, 'error')
})
