const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const readline = require('readline');

// Mission Control DB path
const dbPath = path.join(__dirname, '../.data/mission-control.db');
const openclawDir = path.join(process.env.HOME, '.openclaw/agents');

if (!fs.existsSync(dbPath)) {
    console.error('Mission Control database not found at:', dbPath);
    process.exit(1);
}

const db = new Database(dbPath);
console.log('Starting session log ingestion from', openclawDir);

// Prepared statements
const findAgentStmt = db.prepare('SELECT id FROM agents WHERE name = ? OR name LIKE ? LIMIT 1');
const insertStmt = db.prepare(`
    INSERT INTO activities (type, entity_type, entity_id, actor, description, data, created_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const checkExistsStmt = db.prepare('SELECT id FROM activities WHERE actor = ? AND data = ? LIMIT 1');

// Keep track of file offsets to avoid double-processing
const fileOffsets = new Map();

function watchFiles() {
    try {
        const agents = fs.readdirSync(openclawDir);
        agents.forEach(agentName => {
            const sessionsDir = path.join(openclawDir, agentName, 'sessions');
            if (!fs.existsSync(sessionsDir)) return;

            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
            files.forEach(file => {
                const filePath = path.join(sessionsDir, file);
                processLogFile(filePath, agentName);
                
                // Watch for changes (polling for stability)
                fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
                    if (curr.size > prev.size) {
                        processLogFile(filePath, agentName);
                    }
                });
                console.log('Watching session log:', filePath);
            });
        });
    } catch (err) {
        console.error('Error scanning agents:', err.message);
    }
}

function processLogFile(filePath, agentName) {
    const stats = fs.statSync(filePath);
    const start = fileOffsets.get(filePath) || 0;
    if (stats.size <= start) return;

    const stream = fs.createReadStream(filePath, { start, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
            const entry = JSON.parse(line);
            const entryStr = JSON.stringify(entry);
            const now = Math.floor(Date.now() / 1000);
            const workspaceId = 1;

            // FILTER: Skip low-level noise
            if (entry.type === 'custom') return;
            if (entry.type === 'openclaw.cache-ttl') return;

            // Simple deduplication
            const exists = checkExistsStmt.get(agentName, entryStr);
            if (exists) return;

            let agentId = 0;
            let actorName = agentName;
            const agent = findAgentStmt.get(agentName, `%${agentName}%`);
            if (agent) {
                agentId = agent.id;
                const actualAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
                if (actualAgent) actorName = actualAgent.name;
            }

            let type = 'agent_action';
            let description = `Agent ${actorName}: ${entry.type || entry.role}`;
            
            if (entry.type === 'summary') {
                type = 'agent_summary';
                description = `Agent ${actorName} completed a turn.`;
                // Skip logging summaries if they don't add much info to the feed
                // return; 
            } else if (entry.role === 'tool') {
                description = `Agent ${actorName} tool result: ${entry.name || 'unknown'}`;
                
                // Specialized extraction for Lobster results
                if (entry.name === 'lobster' && entry.content && entry.content[0]?.text) {
                    try {
                        const envelope = JSON.parse(entry.content[0].text);
                        if (envelope.ok) {
                            const status = envelope.status || 'completed';
                            const stepCount = envelope.output?.length || 0;
                            description = `Lobster Run [${status}]: Agent ${actorName} executed ${stepCount} steps.`;
                            type = 'lobster_run';
                        } else if (envelope.error) {
                            description = `Lobster Error: ${envelope.error.message}`;
                            type = 'lobster_error';
                        }
                    } catch (e) {}
                }
            } else if (entry.type === 'tool_call') {
                description = `Agent ${actorName} calling tool: ${entry.tool || entry.name || 'unknown'}`;
            } else if (entry.type === 'message' && entry.message) {
                const msg = entry.message;
                
                if (msg.role === 'toolResult') {
                    const toolName = msg.toolName || 'unknown';
                    let resultPreview = '';
                    if (Array.isArray(msg.content) && msg.content[0]?.text) {
                        resultPreview = msg.content[0].text.substring(0, 100);
                    }
                    description = `Agent ${actorName} tool result [${toolName}]: ${resultPreview}${resultPreview.length >= 100 ? '...' : ''}`;
                    
                    // Specialized check for Lobster in message format
                    if (toolName === 'lobster' && Array.isArray(msg.content) && msg.content[0]?.text) {
                        try {
                            const envelope = JSON.parse(msg.content[0].text);
                            if (envelope.ok) {
                                description = `Lobster Run [${envelope.status || 'completed'}]: Agent ${actorName} executed ${envelope.output?.length || 0} steps.`;
                                type = 'lobster_run';
                            }
                        } catch (e) {}
                    }
                } else {
                    const content = msg.content;
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
            }

            // Skip empty/generic action descriptions to keep feed high-signal
            if (description.endsWith(': message') || description.endsWith(': turn')) return;

            insertStmt.run(
                type,
                'agent',
                agentId,
                actorName,
                description,
                JSON.stringify(entry),
                now,
                workspaceId
            );

            // AUTO-ADVANCE PIPELINES
            if (type === 'lobster_run' || entry.type === 'summary') {
                try {
                    let targetRunId = null;
                    const runIdMatch = description.match(/\[PIPELINE_RUN:(\d+)\]/);
                    if (runIdMatch) {
                        targetRunId = parseInt(runIdMatch[1]);
                    }

                    const activeRuns = targetRunId 
                        ? db.prepare('SELECT id FROM pipeline_runs WHERE id = ? AND status = \'running\'').all(targetRunId)
                        : db.prepare('SELECT id FROM pipeline_runs WHERE status = \'running\' AND triggered_by = ?').all(actorName);

                    for (const run of activeRuns) {
                        console.log(`[PIPELINE] Auto-advancing run #${run.id} due to ${actorName} ${type}.`);
                        fetch(`http://localhost:3005/api/pipelines/run`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-api-key': 'system-internal' },
                            body: JSON.stringify({ action: 'advance', run_id: run.id, success: !entry.isError })
                        }).catch(e => console.error('[PIPELINE] API call failed:', e.message));
                    }
                } catch (err) {
                    console.error('[PIPELINE] Auto-advance check failed:', err.message);
                }
            }
        } catch (err) {
            console.error('Error processing line:', err.message);
        }
    });

    stream.on('end', () => {
        fileOffsets.set(filePath, stats.size);
    });
}

watchFiles();
