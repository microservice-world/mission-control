#!/bin/bash

# Mission Control Phase 4: Orchestrated Heartbeat Script
# Called by OpenClaw cron every 1 minute.
# Delegates orchestration to the "Big Chief" (andy-manager).

set -e

# Configuration
MISSION_CONTROL_URL="${MISSION_CONTROL_URL:-https://openclaw.local}"
API_KEY="${API_KEY:-mission-control-api-key-change-me}"
LOG_DIR="${LOG_DIR:-$HOME/.mission-control/logs}"
LOG_FILE="$LOG_DIR/agent-heartbeat-$(date +%Y-%m-%d).log"
OPENCLAW_CMD="${OPENCLAW_CMD:-openclaw}"
CHIEF_AGENT="andy-manager"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Logging function
log() {
    local level="$1"
    shift
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" | tee -a "$LOG_FILE"
}

# Check if Mission Control is running
check_mission_control() {
    if ! curl -k -s -H "x-api-key: $API_KEY" "$MISSION_CONTROL_URL/api/status" > /dev/null 2>&1; then
        log "ERROR" "Mission Control not accessible at $MISSION_CONTROL_URL"
        return 1
    fi
    return 0
}

# Get list of all pending tasks from Mission Control
check_all_work() {
    log "INFO" "Checking Mission Control for any pending work items..."
    
    # Check if ANY agent has pending items via a global or summarized heartbeat check
    # Alternatively, just list all agents and check their heartbeats
    local agents
    agents=$(curl -k -s -H "x-api-key: $API_KEY" "$MISSION_CONTROL_URL/api/agents?limit=100" 2>/dev/null | jq -r '.agents[] | .name' 2>/dev/null)
    
    local total_work_items=0
    local work_details=""
    
    for agent_name in $agents; do
        local response
        response=$(curl -k -s -H "x-api-key: $API_KEY" "$MISSION_CONTROL_URL/api/agents/$agent_name/heartbeat" 2>/dev/null)
        local status
        status=$(echo "$response" | jq -r '.status' 2>/dev/null)
        
        if [[ "$status" == "WORK_ITEMS_FOUND" ]]; then
            local count
            count=$(echo "$response" | jq -r '.total_items' 2>/dev/null)
            total_work_items=$((total_work_items + count))
            work_details+="- $agent_name: $count items\n"
        fi
    done
    
    if [[ $total_work_items -gt 0 ]]; then
        log "INFO" "Found $total_work_items work items across the army. Waking the Chief ($CHIEF_AGENT)."
        wake_the_chief "$total_work_items" "$work_details"
    else
        log "INFO" "No work found for any agent."
    fi
}

# Wake the Chief Agent (andy-manager) to handle orchestration
wake_the_chief() {
    local total_count="$1"
    local details="$2"
    
    # Get Chief's session_id from Mission Control
    local session_id
    session_id=$(curl -k -s -H "x-api-key: $API_KEY" "$MISSION_CONTROL_URL/api/agents?limit=100" 2>/dev/null | jq -r ".agents[] | select(.name == \"$CHIEF_AGENT\") | .session_id" 2>/dev/null || echo "")
    
    if [[ -z "$session_id" || "$session_id" == "null" ]]; then
        log "ERROR" "Cannot wake the Chief: No session_id found for $CHIEF_AGENT"
        return 1
    fi
    
    local wake_message="🚨 **SYSTEM ORCHESTRATION REQUEST**\n\n"
    wake_message+="Chief, there are **$total_count** pending work items in Mission Control that need your attention:\n\n"
    wake_message+="$details\n"
    wake_message+="Please use your mission-control skill to investigate and delegate these tasks to the appropriate agents. Ensure all task statuses are updated correctly.\n\n"
    wake_message+="⏰ $(date '+%Y-%m-%d %H:%M:%S')"
    
    if "$OPENCLAW_CMD" agent --session-id "$session_id" --message "$wake_message" >> "$LOG_FILE" 2>&1; then
        log "INFO" "Orchestration request successfully delivered to $CHIEF_AGENT"
    else
        log "ERROR" "Failed to deliver orchestration request to $CHIEF_AGENT"
    fi
}

# Main
main() {
    if ! check_mission_control; then
        exit 1
    fi
    check_all_work
}

main
