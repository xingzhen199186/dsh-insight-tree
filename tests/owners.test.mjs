import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_OWNER_LABELS, aggregatePluginUse, toolOwnerOf } from '../lib/index.js'

test('toolOwnerOf 归属规则：curated / mnemon / 核心 / 其他', () => {
  assert.equal(toolOwnerOf('ask_advisors'), 'dsh-advisor-group')
  assert.equal(toolOwnerOf('mnemon_recall'), 'dsh-mnemon')
  assert.equal(toolOwnerOf('hindsight_reflect'), 'dsh-mnemon')
  assert.equal(toolOwnerOf('read'), 'DSH 核心（内置工具）')
  assert.equal(toolOwnerOf('pwsh'), 'DSH 核心（内置工具）')
  assert.equal(toolOwnerOf('totally-unknown'), '其他插件工具')
  assert.ok(TOOL_OWNER_LABELS.ask_advisors === 'dsh-advisor-group')
})

test('aggregatePluginUse 把工具计数聚合到插件', () => {
  const out = aggregatePluginUse({
    ask_advisors: { count: 2 },
    mnemon_recall: { count: 1 },
    read: { count: 10 },
    grep: { count: 3 },
    unknown_tool: { count: 4 },
  })
  assert.equal(out['dsh-advisor-group'], 2)
  assert.equal(out['dsh-mnemon'], 1)
  assert.equal(out['DSH 核心（内置工具）'], 13)
  assert.equal(out['其他插件工具'], 4)
})

test('空输入返回空聚合', () => {
  assert.deepEqual(aggregatePluginUse(undefined), {})
})

test('运行时 toolOwners 映射优先于 curated 规则', () => {
  const out = aggregatePluginUse({ ask_advisors: { count: 1 }, some_unknown_tool: { count: 2 } }, { ask_advisors: 'dsh-advisor-group', some_unknown_tool: 'my-custom-plugin' })
  assert.equal(out['dsh-advisor-group'], 1)
  assert.equal(out['my-custom-plugin'], 2)
})
