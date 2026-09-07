import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVITY_KEY, activityFromEvents, createActivityDefinition, foldActivityEvent, sessionUsageFromActivity } from '../lib/index.js'

test('foldActivityEvent 累计事件与工具调用', () => {
  let state = { events: 0, toolCalls: 0, byEventType: {}, byTool: {} }
  state = foldActivityEvent(state, { type: 'turn/start' })
  state = foldActivityEvent(state, { type: 'tool/call', data: { name: 'bash' } })
  state = foldActivityEvent(state, { type: 'tool/call', data: { name: 'bash' } })
  assert.equal(state.events, 3)
  assert.equal(state.toolCalls, 2)
  assert.equal(state.byEventType['turn/start'], 1)
  assert.equal(state.byTool.bash.count, 2)
  assert.ok(state.lastActivity)
})

test('显式插件来源会保存到工具归属投影', () => {
  const state = foldActivityEvent({ events: 0, toolCalls: 0, byEventType: {}, byTool: {} }, {
    type: 'tool/call',
    data: { name: 'search_docs', plugin: 'docs-plugin' },
  })
  assert.deepEqual(state.toolOwners, { search_docs: 'docs-plugin' })
})

test('无 type 事件保持原引用', () => {
  const state = { events: 1, toolCalls: 0, byEventType: {}, byTool: {} }
  assert.equal(foldActivityEvent(state, {}), state)
})

test('activity 定义 key/init/stateVersion', () => {
  const definition = createActivityDefinition()
  assert.equal(definition.key, ACTIVITY_KEY)
  assert.equal(definition.stateVersion, 1)
  assert.deepEqual(definition.init({}, 0), { events: 0, toolCalls: 0, byEventType: {}, byTool: {} })
})

test('activityFromEvents 可回放历史工具调用并保留事件时间', () => {
  const state = activityFromEvents([
    { type: 'assistant/message', time: 1700000000000 },
    { type: 'tool/call', time: 1700000001000, data: { name: 'hindsight_context_search' } },
    { type: 'tool/call', time: 1700000002000, data: { name: 'hindsight_context_search' } },
  ])
  assert.equal(state.events, 3)
  assert.equal(state.toolCalls, 2)
  assert.equal(state.byTool.hindsight_context_search.count, 2)
  assert.equal(state.byTool.hindsight_context_search.lastActivity, new Date(1700000002000).toISOString())
  assert.equal(state.lastActivity, new Date(1700000002000).toISOString())
})

test('activityFromEvents 回放事件中的显式插件来源', () => {
  const state = activityFromEvents([
    { type: 'tool/call', time: 1700000000000, data: { name: 'search_docs', source: 'docs-plugin' } },
  ])
  assert.deepEqual(state.toolOwners, { search_docs: 'docs-plugin' })
})

test('不同历史会话的回放状态互不串联', () => {
  const first = activityFromEvents([{ type: 'tool/call', time: 1700000000000, data: { name: 'mnemon_status' } }])
  const second = activityFromEvents([{ type: 'tool/call', time: 1700000001000, data: { name: 'hindsight_context_search' } }])
  assert.equal(first.toolCalls, 1)
  assert.equal(second.toolCalls, 1)
  assert.equal(first.byTool.hindsight_context_search, undefined)
  assert.equal(second.byTool.mnemon_status, undefined)
})

test('实时和历史报告使用同一套插件归属统计', () => {
  const usage = sessionUsageFromActivity({
    events: 2,
    toolCalls: 2,
    byTool: {
      mnemon_status: { count: 2, lastActivity: '2026-09-06T12:00:00.000Z' },
      read: { count: 1, lastActivity: '2026-09-06T12:01:00.000Z' },
    },
    toolOwners: { mnemon_status: 'dsh-mnemon' },
    source: 'projection',
  })
  assert.deepEqual(usage['dsh-mnemon'], { count: 2, lastActivity: '2026-09-06T12:00:00.000Z' })
  assert.deepEqual(usage['DSH 核心（内置工具）'], { count: 1, lastActivity: '2026-09-06T12:01:00.000Z' })
})
