import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../src/main/store'
import { registerSelectedApp, renameApp } from '../src/main/apps'
import { fingerprint } from '../src/main/tools'

async function withFixture(check: (store: Store, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'changli-apps-'))
  const store = new Store(join(dir, 'test.sqlite'))
  try { await check(store, dir) }
  finally {
    store.close()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep + 'changli-apps-'))
    rmSync(dir, { recursive: true, force: true })
  }
}

test('选择程序自动生成内部 ID/名称，首次未授权，同名程序可区分', async () => {
  await withFixture(async (store, dir) => {
    const targets: string[] = []
    for (const folder of ['first', 'second', 'third']) {
      const location = join(dir, folder)
      mkdirSync(location)
      const target = join(location, '播放器.exe')
      writeFileSync(target, 'test-fixture-not-an-executable')
      targets.push(target)
    }
    const firstId = await registerSelectedApp(store, targets[0])
    const first = store.apps().find(a => a.id === firstId)!
    assert.match(firstId, /^app_[a-f0-9-]{36}$/)
    assert.ok(firstId.length <= 40)
    assert.equal(first.name, '播放器')
    assert.equal(first.target, targets[0])
    assert.equal(first.approved, false)
    assert.equal(first.fingerprint, await fingerprint(targets[0]))

    const secondId = await registerSelectedApp(store, targets[1])
    const thirdId = await registerSelectedApp(store, targets[2])
    assert.equal(new Set([firstId, secondId, thirdId]).size, 3)
    assert.deepEqual(store.apps().map(a => a.name).sort(), ['播放器', '播放器（2）', '播放器（3）'].sort())
    assert.ok(store.apps().every(a => !a.approved))
    assert.equal(store.tools().length, 0)
  })
})

test('重复选择保留旧自定义 ID/名称及有效授权，文件目标变化撤销授权', async () => {
  await withFixture(async (store, dir) => {
    const target = join(dir, 'legacy.exe')
    writeFileSync(target, 'original-test-fixture')
    const existing = { id: 'old_music', name: '用户原有的音乐播放器', target, approved: true, fingerprint: await fingerprint(target) }
    store.saveApp(existing)

    assert.equal(await registerSelectedApp(store, target), existing.id)
    assert.deepEqual(store.apps(), [existing])
    writeFileSync(target, 'changed-test-fixture-with-a-different-size')
    assert.equal(await registerSelectedApp(store, target), existing.id)
    const changed = store.apps()[0]
    assert.equal(store.apps().length, 1)
    assert.equal(changed.id, existing.id)
    assert.equal(changed.name, existing.name)
    assert.equal(changed.target, existing.target)
    assert.equal(changed.approved, false)
    assert.notEqual(changed.fingerprint, existing.fingerprint)
    assert.equal(changed.fingerprint, await fingerprint(target))
    assert.equal(store.tools().length, 0)
  })
})

test('修改名称保留内部标识/目标/权限，并拒绝空名称、冲突和非法对象', async () => {
  await withFixture(async (store, dir) => {
    const target = join(dir, 'player.exe')
    const otherTarget = join(dir, 'other.exe')
    writeFileSync(target, 'test-fixture'); writeFileSync(otherTarget, 'other-test-fixture')
    const id = await registerSelectedApp(store, target)
    const otherId = await registerSelectedApp(store, otherTarget)
    const original = store.apps().find(a => a.id === id)!
    store.saveApp({ ...original, approved: true })

    renameApp(store, { id, name: '  音乐播放器  ' })
    const renamed = { ...original, name: '音乐播放器', approved: true }
    assert.deepEqual(store.apps().find(a => a.id === id), renamed)
    const beforeInvalid = store.apps()
    const duplicate = store.apps().find(a => a.id === otherId)!.name
    for (const value of [null, undefined, {}, [], { id }, { id: 42, name: '正常名称' },
      { id, name: null }, { id, name: '' }, { id, name: '   ' }, { id, name: 'x'.repeat(81) },
      { id: 'missing-app', name: '正常名称' }, { id, name: duplicate }]) {
      assert.throws(() => renameApp(store, value as { id: string; name: string }))
      assert.deepEqual(store.apps(), beforeInvalid)
    }
    assert.equal(store.tools().length, 0)
  })
})

test('选择器结果仍拒绝解释器、非 exe、目录及不存在的目标，不创建授权记录', async () => {
  await withFixture(async (store, dir) => {
    for (const file of ['cmd.exe', 'PoWeRsHeLl.ExE', 'pwsh.exe', 'wscript.exe', 'cscript.exe',
      'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'script.cmd', 'script.bat', 'script.ps1', 'shortcut.lnk', 'text.txt']) {
      const target = join(dir, file)
      writeFileSync(target, 'test-fixture-not-an-executable')
      await assert.rejects(registerSelectedApp(store, target))
      assert.equal(store.apps().length, 0)
    }
    const directory = join(dir, 'directory.exe')
    mkdirSync(directory)
    await assert.rejects(registerSelectedApp(store, directory))
    await assert.rejects(registerSelectedApp(store, join(dir, 'does-not-exist.exe')), error =>
      error instanceof Error && error.message.includes('无法读取') && !error.message.includes(dir))
    assert.equal(store.apps().length, 0)
    assert.equal(store.tools().length, 0)
  })
})
