import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, createHotOperations, minimumReleaseAgeFailure, runtimeFor } from '../lib/index.js'

test('识别 pnpm 全 lockfile 冷静期失败', () => {
  assert.equal(minimumReleaseAgeFailure({ code: 1, stdout: '', stderr: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' }), true)
  assert.equal(minimumReleaseAgeFailure({ code: 1, stdout: '', stderr: '普通卸载失败' }), false)
  assert.equal(minimumReleaseAgeFailure({ code: 0, stdout: 'minimum-release-age', stderr: '' }), false)
})

test('没有宿主 plugin 服务时热挂载保守返回 false', async () => {
  const hot = createHotOperations(undefined, 'C:\\missing-profile')
  assert.equal(await hot.mount('missing-plugin'), false)
  assert.equal(await hot.unmount('missing-plugin'), false)
})

test('runtimeFor 通过模块名立即更新并移除 Loader 条目', async () => {
  const updates = []
  const removed = []
  const entries = [
    {
      id: 'mnemon',
      options: { id: 'mnemon', name: 'dsh-mnemon' },
      update: async (options) => updates.push(['mnemon', options]),
    },
    {
      id: 'include:mnemon',
      options: { name: 'cordis:include' },
      update: async () => updates.push(['structural', {}]),
    },
  ]
  const runtime = runtimeFor({ entries: () => entries, remove: async (id) => removed.push(id) })

  assert.deepEqual(await runtime.setDisabled('dsh-mnemon', true), { matched: 1 })
  assert.deepEqual(await runtime.setDisabled('dsh-mnemon', false), { matched: 1 })
  assert.deepEqual(await runtime.remove('dsh-mnemon'), { matched: 1 })
  assert.deepEqual(updates, [['mnemon', { disabled: true }], ['mnemon', { disabled: null }]])
  assert.deepEqual(removed, ['mnemon'])
})

test('runtimeFor 在更新失败时回滚已经处理的条目', async () => {
  const updates = []
  let calls = 0
  const entries = [
    { id: 'one', options: { name: 'demo' }, update: async (options) => { calls += 1; updates.push(['one', options]); } },
    { id: 'two', options: { name: 'demo' }, update: async (options) => { calls += 1; updates.push(['two', options]); if (calls === 2) throw new Error('failed') } },
  ]
  const runtime = runtimeFor({ entries: () => entries, remove: async () => {} })
  await assert.rejects(() => runtime.setDisabled('demo', true), /failed/u)
  assert.deepEqual(updates, [['one', { disabled: true }], ['two', { disabled: true }], ['one', { disabled: null }]])
})

test('工具注册归属补丁保留原始调用上下文', () => {
  const calls = []
  const tools = { register(definition) { calls.push([this, definition]); return 'registered' } }
  const effects = []
  const ctx = {
    get(key) { return key === 'tools' ? tools : undefined },
    effect(disposer) { effects.push(disposer()) },
    inject() {},
    on() {},
  }
  apply(ctx, { profile: 'web', dshVersion: '0.1.2-rc.1', token: '' })
  const receiver = { ctx: { fiber: { entry: { options: { name: 'demo-plugin' } } } } }
  assert.equal(tools.register.call(receiver, { name: 'demo-tool' }), 'registered')
  assert.equal(calls[0][0], receiver)
  assert.deepEqual(calls[0][1], { name: 'demo-tool' })
  for (const dispose of effects) dispose?.()
})
