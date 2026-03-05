/**
 * Agent Config Sync
 *
 * Reads agents from openclaw.json and upserts them into the MC database.
 * Used by both the /api/agents/sync endpoint and the startup scheduler.
 */

import { config } from './config'
import { getDatabase, db_helpers, logAuditEvent } from './db'
import { eventBus } from './event-bus'
import { join, isAbsolute, resolve } from 'path'
import path from 'path'
import { existsSync, readFileSync } from 'fs'
import { resolveWithin } from './paths'
import { logger } from './logger'

interface OpenClawAgent {
  id: string
  name?: string
  default?: boolean
  workspace?: string
  agentDir?: string
  model?: {
    primary?: string
    fallbacks?: string[]
  }
  identity?: {
    name?: string
    theme?: string
    emoji?: string
  }
  subagents?: any
  sandbox?: {
    mode?: string
    workspaceAccess?: string
    scope?: string
    docker?: any
  }
  tools?: {
    allow?: string[]
    deny?: string[]
  }
  memorySearch?: any
}

export interface SyncResult {
  synced: number
  created: number
  updated: number
  agents: Array<{
    id: string
    name: string
    action: 'created' | 'updated' | 'unchanged'
  }>
  error?: string
}

export interface SyncDiff {
  inConfig: number
  inMC: number
  newAgents: string[]
  updatedAgents: string[]
  onlyInMC: string[]
}

function parseIdentityFromFile(content: string): { name?: string; theme?: string; emoji?: string; content?: string } {
  if (!content.trim()) return {}
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean)
  let name: string | undefined
  let theme: string | undefined
  let emoji: string | undefined

  for (const line of lines) {
    if (!name && line.startsWith('#')) {
      name = line.replace(/^#+\s*/, '').trim()
      continue
    }

    if (!theme) {
      const themeMatch = line.match(/^theme\s*:\s*(.+)$/i)
      if (themeMatch?.[1]) {
        theme = themeMatch[1].trim()
        continue
      }
    }

    if (!emoji) {
      const emojiMatch = line.match(/^emoji\s*:\s*(.+)$/i)
      if (emojiMatch?.[1]) {
        emoji = emojiMatch[1].trim()
      }
    }
  }

  return {
    ...(name ? { name } : {}),
    ...(theme ? { theme } : {}),
    ...(emoji ? { emoji } : {}),
    content: lines.slice(0, 8).join('\n'),
  }
}

function parseToolsFromFile(content: string): { allow?: string[]; raw?: string } {
  if (!content.trim()) return {}

  const parsedTools = new Set<string>()
  for (const line of content.split('\n')) {
    const cleaned = line.trim()
    if (!cleaned || cleaned.startsWith('#')) continue

    const listMatch = cleaned.match(/^[-*]\s+`?([^`]+?)`?\s*$/)
    if (listMatch?.[1]) {
      parsedTools.add(listMatch[1].trim())
      continue
    }

    const inlineMatch = cleaned.match(/^`([^`]+)`$/)
    if (inlineMatch?.[1]) {
      parsedTools.add(inlineMatch[1].trim())
    }
  }

  const allow = [...parsedTools].filter(Boolean)
  return {
    ...(allow.length > 0 ? { allow } : {}),
    raw: content.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 24).join('\n'),
  }
}

function getConfigPath(): string | null {
  return config.openclawConfigPath || null
}

function resolveAgentWorkspacePath(workspace: string): string {
  if (isAbsolute(workspace)) return resolve(workspace)
  if (!config.openclawStateDir) {
    throw new Error('OPENCLAW_STATE_DIR not configured')
  }
  return resolveWithin(config.openclawStateDir, workspace)
}

/** Safely read a file from an agent's workspace directory */
function readWorkspaceFile(workspace: string | undefined, filename: string): string | null {
  if (!workspace) return null
  try {
    const safeWorkspace = resolveAgentWorkspacePath(workspace)
    const safePath = resolveWithin(safeWorkspace, filename)
    if (existsSync(safePath)) {
      return readFileSync(safePath, 'utf-8')
    }
  } catch (err) {
    logger.warn({ err, workspace, filename }, 'Failed to read workspace file')
  }
  return null
}

export function enrichAgentConfigFromWorkspace(configData: any): any {
  if (!configData || typeof configData !== 'object') return configData
  const workspace = typeof configData.workspace === 'string' ? configData.workspace : undefined
  if (!workspace) return configData

  const identityFile = readWorkspaceFile(workspace, 'identity.md')
  const toolsFile = readWorkspaceFile(workspace, 'TOOLS.md')

  const mergedIdentity = {
    ...parseIdentityFromFile(identityFile || ''),
    ...((configData.identity && typeof configData.identity === 'object') ? configData.identity : {}),
  }
  const mergedTools = {
    ...parseToolsFromFile(toolsFile || ''),
    ...((configData.tools && typeof configData.tools === 'object') ? configData.tools : {}),
  }

  return {
    ...configData,
    identity: Object.keys(mergedIdentity).length > 0 ? mergedIdentity : configData.identity,
    tools: Object.keys(mergedTools).length > 0 ? mergedTools : configData.tools,
  }
}

/** Read and parse openclaw.json agents list */
async function readOpenClawAgents(): Promise<OpenClawAgent[]> {
  const configPath = getConfigPath()
  if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH not configured')

  const { readFile } = require('fs/promises')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw)
  return parsed?.agents?.list || []
}

/** Extract MC-friendly fields from an OpenClaw agent config */
function mapAgentToMC(agent: OpenClawAgent): {
  name: string
  role: string
  config: any
  soul_content: string | null
  session_id: string | null
} {
  const name = agent.identity?.name || agent.name || agent.id
  const role = agent.identity?.theme || 'agent'
  // Store the full config minus systemPrompt/soul (which can be large)
  const configData = enrichAgentConfigFromWorkspace({
    openclawId: agent.id,
    model: agent.model,
    identity: agent.identity,
    sandbox: agent.sandbox,
    tools: agent.tools,
    subagents: agent.subagents,
    memorySearch: agent.memorySearch,
    workspace: agent.workspace,
    agentDir: agent.agentDir,
    isDefault: agent.default || false,
  })

  // Read soul.md from the agent's workspace if available
  const soul_content = readWorkspaceFile(agent.workspace, 'soul.md')

  // Read session_id from agent's sessions.json if available
  let session_id: string | null = null
  try {
    const sessionsContent = readWorkspaceFile(agent.workspace, 'sessions/sessions.json')
    if (sessionsContent) {
      const sessions = JSON.parse(sessionsContent)
      const sessionKey = `agent:${agent.id}:main`
      if (sessions[sessionKey]) {
        session_id = sessions[sessionKey].sessionId
      }
    }
  } catch (err) {
    logger.warn({ err, agent: agent.id }, 'Failed to read session_id for agent')
  }

  return { name, role, config: configData, soul_content, session_id }
}

/** Sync agents from openclaw.json into the MC database and vice-versa */
export async function syncAgentsBidirectional(actor: string = 'system'): Promise<SyncResult> {
  const configPath = getConfigPath()
  if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH not configured')

  // 1. Read from OpenClaw config
  let configAgents: OpenClawAgent[] = []
  try {
    configAgents = await readOpenClawAgents()
  } catch (err: any) {
    logger.error({ err }, 'Failed to read OpenClaw agents for sync')
  }

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  let created = 0
  let updated = 0
  const results: SyncResult['agents'] = []

  // 2. Read from Mission Control database
  const allMCAgents = db.prepare('SELECT id, name, role, config, soul_content, session_id FROM agents').all() as any[]
  
  // Helper to find session_id from disk
  const findSessionIdOnDisk = (agentId: string, workspace: string | undefined): string | null => {
    try {
      const openclawStateDir = config.openclawStateDir
      if (!openclawStateDir) return null
      
      const sessionsFile = path.join(openclawStateDir, 'agents', agentId, 'sessions', 'sessions.json')
      if (!existsSync(sessionsFile)) return null
      
      const raw = readFileSync(sessionsFile, 'utf-8')
      const sessions = JSON.parse(raw)
      const sessionKey = `agent:${agentId}:main`
      return sessions[sessionKey]?.sessionId || null
    } catch {
      return null
    }
  }

  // A. Push from Config to MC
  for (const cAgent of configAgents) {
    const mapped = mapAgentToMC(cAgent)
    // Try to find session_id if mapped didn't get it
    if (!mapped.session_id) {
      mapped.session_id = findSessionIdOnDisk(cAgent.id, cAgent.workspace)
    }
    
    const existing = allMCAgents.find(a => a.name === mapped.name)
    const configJson = JSON.stringify(mapped.config)

    if (existing) {
      const existingConfig = existing.config || '{}'
      const existingSoul = existing.soul_content || null
      const existingSessionId = existing.session_id || null
      
      const configChanged = existingConfig !== configJson || existing.role !== mapped.role
      const soulChanged = mapped.soul_content !== null && mapped.soul_content !== existingSoul
      const sessionChanged = mapped.session_id !== null && mapped.session_id !== existingSessionId

      if (configChanged || soulChanged || sessionChanged) {
        const soulToWrite = mapped.soul_content ?? existingSoul
        db.prepare('UPDATE agents SET role = ?, config = ?, soul_content = ?, updated_at = ?, session_id = ? WHERE name = ?')
          .run(mapped.role, configJson, soulToWrite, now, mapped.session_id || existingSessionId, mapped.name)
        results.push({ id: cAgent.id, name: mapped.name, action: 'updated' })
        updated++
      }
    } else {
      db.prepare(`
        INSERT INTO agents (name, role, soul_content, status, created_at, updated_at, config, session_id, workspace_id)
        VALUES (?, ?, ?, 'offline', ?, ?, ?, ?, 1)
      `).run(mapped.name, mapped.role, mapped.soul_content, now, now, configJson, mapped.session_id)
      results.push({ id: cAgent.id, name: mapped.name, action: 'created' })
      created++
    }
  }

  // B. Push from MC to Config (Agents created in UI but not in config)
  const configIds = new Set(configAgents.map(a => a.id))
  for (const mcAgent of allMCAgents) {
    const openclawId = mcAgent.name.toLowerCase().replace(/\s+/g, '-')
    if (!configIds.has(openclawId)) {
      try {
        const parsedConfig = JSON.parse(mcAgent.config || '{}')
        await writeAgentToConfig({
          id: openclawId,
          name: mcAgent.name,
          ...(parsedConfig.model && { model: parsedConfig.model }),
          ...(parsedConfig.identity && { identity: parsedConfig.identity }),
          ...(parsedConfig.sandbox && { sandbox: parsedConfig.sandbox }),
          ...(parsedConfig.tools && { tools: parsedConfig.tools }),
          ...(parsedConfig.subagents && { subagents: parsedConfig.subagents }),
          ...(parsedConfig.memorySearch && { memorySearch: parsedConfig.memorySearch }),
          workspace: parsedConfig.workspace || '/home/nic/.openclaw/workspace',
        })
        results.push({ id: openclawId, name: mcAgent.name, action: 'updated' })
        updated++
      } catch (err) {
        logger.error({ err, agent: mcAgent.name }, 'Failed to push MC agent to config during sync')
      }
    }
  }

  if (created > 0 || updated > 0) {
    logAuditEvent({
      action: 'agent_bidirectional_sync',
      actor,
      detail: { created, updated },
    })
    eventBus.broadcast('agent.created', { type: 'sync', created, updated })
  }

  return { synced: configAgents.length, created, updated, agents: results }
}

/** Preview the diff between openclaw.json and MC database without writing */
export async function previewSyncDiff(): Promise<SyncDiff> {
  let agents: OpenClawAgent[]
  try {
    agents = await readOpenClawAgents()
  } catch {
    return { inConfig: 0, inMC: 0, newAgents: [], updatedAgents: [], onlyInMC: [] }
  }

  const db = getDatabase()
  const allMCAgents = db.prepare('SELECT name, role, config FROM agents').all() as Array<{ name: string; role: string; config: string }>
  const mcNames = new Set(allMCAgents.map(a => a.name))

  const newAgents: string[] = []
  const updatedAgents: string[] = []
  const configNames = new Set<string>()

  for (const agent of agents) {
    const mapped = mapAgentToMC(agent)
    configNames.add(mapped.name)

    const existing = allMCAgents.find(a => a.name === mapped.name)
    if (!existing) {
      newAgents.push(mapped.name)
    } else {
      const configJson = JSON.stringify(mapped.config)
      if (existing.config !== configJson || existing.role !== mapped.role) {
        updatedAgents.push(mapped.name)
      }
    }
  }

  const onlyInMC = allMCAgents
    .map(a => a.name)
    .filter(name => !configNames.has(name))

  return {
    inConfig: agents.length,
    inMC: allMCAgents.length,
    newAgents,
    updatedAgents,
    onlyInMC,
  }
}

/** Write an agent config back to openclaw.json agents.list */
export async function writeAgentToConfig(agentConfig: any): Promise<void> {
  const configPath = getConfigPath()
  if (!configPath) throw new Error('OPENCLAW_CONFIG_PATH not configured')

  const { readFile, writeFile } = require('fs/promises')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = JSON.parse(raw)

  if (!parsed.agents) parsed.agents = {}
  if (!parsed.agents.list) parsed.agents.list = []

  // Find existing by id
  const idx = parsed.agents.list.findIndex((a: any) => a.id === agentConfig.id)
  if (idx >= 0) {
    // Deep merge: preserve fields not in update
    parsed.agents.list[idx] = deepMerge(parsed.agents.list[idx], agentConfig)
  } else {
    parsed.agents.list.push(agentConfig)
  }

  await writeFile(configPath, JSON.stringify(parsed, null, 2) + '\n')
}

/** Deep merge two objects (target <- source), preserving target fields not in source */
function deepMerge(target: any, source: any): any {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
