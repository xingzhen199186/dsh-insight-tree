/**
 * Tool → plugin owner attribution.
 *
 * DSH session events (`tool/call`) carry only the tool name, never the owning
 * bundle, so plugin-level activity usually cannot be read off the event
 * directly. This module keeps naming rules for explicit owners and core tools;
 * callers only present plugin-level activity as confirmed when the event gave
 * an owner.
 */

export const TOOL_OWNER_LABELS: Record<string, string> = {
  ask_advisors: 'dsh-advisor-group',
}

const CORE_TOOL_RE = /^(read|write|edit|bash|pwsh|grep|glob|read_image|web_search|skill|todo_write|ask_user_question|phase_begin|phase_advance|tools_catalog|tools_help|get_goal|update_goal|create_goal|delivery_check|dev_router_status|dev_reload_preset_live|dev_reset_experience|job_list|job_kill|job_output|doctor|verify_session|scan_discover|retract_import|import_agents|import_chat|import_mcp|import_settings|config_backup|config_list_snapshots|config_restore|config_sync_push|config_sync_pull|export_bundle|export_chat|restore_bundle|sync_to_claude|list_agents|list_imported_sessions|send_message|subagent|subagent_fork|workflow|ralph|tools_|exit_plan_mode|ssh_|str_replace_editor)$/u

export function toolOwnerOf(toolName: string): string {
  if (TOOL_OWNER_LABELS[toolName]) return TOOL_OWNER_LABELS[toolName]
  if (/^mnemon_/u.test(toolName) || /^hindsight_/u.test(toolName)) return 'dsh-mnemon'
  if (CORE_TOOL_RE.test(toolName)) return 'DSH 核心（内置工具）'
  return '其他插件工具'
}

/**
 * Aggregate a projection's by-tool counts into by-owner counts (plugins).
 * An explicit `toolOwners` map from session events wins; the curated rules are
 * retained for core/legacy exports that intentionally opt into inference.
 */
export function aggregatePluginUse(byTool: Record<string, { count: number }> | undefined, toolOwners?: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, item] of Object.entries(byTool ?? {})) {
    const owner = toolOwners?.[name] ?? toolOwnerOf(name)
    const count = item?.count ?? 0
    out[owner] = (out[owner] ?? 0) + count
  }
  return out
}
