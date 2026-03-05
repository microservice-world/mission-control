#!/usr/bin/env node

/**
 * Mission Control Log Ingester v3
 * Tails all agent *.jsonl session logs and pushes them to Mission Control activities.
 * Processes entire file on first discovery.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = '/home/nic/mission-control/.data/mission-control.db';
const OPENCLAW_AGENTS_DIR = '/home/nic/.openclaw/agents';

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insertStmt = db.prepare(`
    INSERT INTO activities (type, entity_type, entity_id, actor, description, data, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Prevent duplicate entries by checking if the activity already exists
const checkExistsStmt = db.prepare(`
    SELECT id FROM activities WHERE actor = ? AND data = ? LIMIT 1
`);

const findAgentStmt = db.prepare('SELECT id FROM agents WHERE name = ? OR config LIKE ?');

console.log(`Starting session log ingestion from ${OPENCLAW_AGENTS_DIR}...`);

const watchers = new Map();
const fileOffsets = new Map();

function scanForSessionFiles() {
    if (!fs.existsSync(OPENCLAW_AGENTS_DIR)) return;

    const agents = fs.readdirSync(OPENCLAW_AGENTS_DIR);
    for (const agentName of agents) {
        const sessionsDir = path.join(OPENCLAW_AGENTS_DIR, agentName, 'sessions');
        if (!fs.existsSync(sessionsDir)) continue;

        const files = fs.readdirSync(sessionsDir);
        for (const file of files) {
            if (file.endsWith('.jsonl') && !file.includes('checkpoint')) {
                const fullPath = path.join(sessionsDir, file);
                if (!watchers.has(fullPath)) {
                    startWatching(fullPath, agentName);
                }
            }
        }
    }
}

function startWatching(filePath, agentName) {
    console.log(`Watching session log: ${filePath}`);
    
    // Process entire file initially
    processFile(filePath, agentName, 0);

    const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
            const start = fileOffsets.get(filePath) || 0;
            processFile(filePath, agentName, start);
        }
    });

    watchers.set(filePath, watcher);
}

function processFile(filePath, agentName, start) {
    const stats = fs.statSync(filePath);
    
    if (stats.size < start) {
        start = 0; // File truncated/rotated
    }

    if (stats.size === start) return;

    const stream = fs.createReadStream(filePath, { start, end: stats.size - 1 });
    let buffer = '';

    stream.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                
                const interesting = ['tool_call', 'tool_result', 'summary', 'message', 'thought'];
                if (interesting.includes(entry.type) || entry.role === 'assistant' || entry.role === 'tool') {
                    
                    const entryStr = JSON.stringify(entry);
                    
                    // Basic deduplication
                    const exists = checkExistsStmt.get(agentName, entryStr);
                    if (exists) continue;

                    let agentId = 0;
                    let actorName = agentName;
                    const agent = findAgentStmt.get(agentName, `%${agentName}%`);
                    if (agent) {
                        agentId = agent.id;
                        // Use the exact name from DB for UI consistency
                        const actualAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
                        if (actualAgent) actorName = actualAgent.name;
                    }

                    let type = 'agent_action';
                    let description = `Agent ${actorName}: ${entry.type || entry.role}`;
                    
                    if (entry.type === 'summary') {
                        type = 'agent_summary';
                        description = `Agent ${actorName} completed a turn.`;
                    } else if (entry.role === 'tool') {
                        description = `Agent ${actorName} received tool result: ${entry.name || 'unknown'}`;
                    } else if (entry.type === 'tool_call') {
                        description = `Agent ${actorName} calling tool: ${entry.tool || entry.name || 'unknown'}`;
                    } else if (entry.type === 'message' && entry.message) {
                        // Extract actual text content if available
                        const content = entry.message.content;
                        if (Array.isArray(content)) {
                            const textItem = content.find(c => c.type === 'text');
                            if (textItem && textItem.text) {
                                description = `Agent ${actorName}: ${textItem.text}`;
                            } else {
                                const thinkingItem = content.find(c => c.type === 'thinking');
                                if (thinkingItem && thinkingItem.thinking) {
                                    description = `Agent ${actorName} (thinking): ${thinkingItem.thinking.substring(0, 100)}...`;
                                }
                            }
                        } else if (typeof content === 'string') {
                            description = `Agent ${actorName}: ${content}`;
                        }
                    }

                    insertStmt.run(
                        type,
                        'agent',
                        agentId,
                        actorName,
                        description,
                        entryStr,
                        1
                    );
                }
            } catch (e) {}
        }
    });

    stream.on('end', () => {
        fileOffsets.set(filePath, stats.size);
    });
}

// Initial scan
scanForSessionFiles();

// Rescan for new files every 30 seconds
setInterval(scanForSessionFiles, 30000);

process.on('SIGINT', () => {
    for (const [path, watcher] of watchers) watcher.close();
    db.close();
    process.exit();
});
