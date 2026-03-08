# Plugin Auto-Repair System Design

## Overview
Automatic health check and repair system for MeMesh/CCB plugin installation to prevent "Claude Code won't start" issues caused by broken plugin configuration.

## Problem Statement
- Plugin installation involves 4 independent config files
- Any single broken path can prevent Claude Code from starting
- Manual intervention required to diagnose and fix
- No memory across sessions → same mistakes repeated

## Solution Architecture

### Components

#### 1. Health Check (`scripts/health-check.js`)
**Purpose**: Fast, non-invasive validation of plugin installation

**Checks**:
1. **Critical Files Exist**
   - `~/.claude/plugins/known_marketplaces.json`
   - `~/.claude/plugins/marketplaces/pcircle-ai` (symlink)
   - `~/.claude/settings.json`
   - `.claude-plugin/memesh/.mcp.json` (plugin MCP configuration)
   - `.claude-plugin/memesh/dist/mcp/server-bootstrap.js`

2. **Configuration Validity**
   - All JSON files parseable
   - `known_marketplaces.json` has `pcircle-ai` entry
   - Symlink points to correct location and target exists
   - `settings.json` has `memesh@pcircle-ai: true`
   - `.mcp.json` has correct MCP server configuration

3. **Version Consistency** (optional deep check)
   - All 4 version files match

**Exit Codes**:
- `0`: All healthy
- `1`: Repairable issue detected
- `2`: Fatal error (dist not built, requires manual intervention)

**Output Format**:
```json
{
  "healthy": true/false,
  "issues": [
    {"path": "marketplace", "severity": "error", "message": "..."},
    {"path": "symlink", "severity": "warning", "message": "..."}
  ],
  "repairNeeded": true/false
}
```

#### 2. Auto-Repair (`scripts/auto-repair.js`)
**Purpose**: Minimal intervention repair of broken paths

**Repair Strategy**:
- **Principle**: Fix only what's broken, preserve user settings
- **Backup**: Always backup before modifying files
- **Verification**: Re-run health check after repair

**Repair Actions**:
| Issue | Action |
|-------|--------|
| dist/ missing | Exit with error (need `npm run build`) |
| Marketplace file missing | Create with pcircle-ai entry |
| Marketplace entry missing | Add pcircle-ai entry |
| Symlink broken/missing | Recreate symlink |
| settings.json missing enabledPlugins | Add object with memesh@pcircle-ai |
| memesh@pcircle-ai = false | Set to true |
| `.mcp.json` missing memesh config | Regenerate `.mcp.json` |
| memesh config incorrect in `.mcp.json` | Update config |

**Backup Strategy**:
- Before modifying any file: `cp file file.backup-{timestamp}`
- Keep last 3 backups per file
- Clean up backups > 7 days old

#### 3. Integration Hook (`.claude/hooks/SessionStart/99-memesh-health-check.sh`)
**Purpose**: Transparent auto-repair on every session start

```bash
#!/bin/bash
# MeMesh Plugin Health Check & Auto-Repair
# Runs on every Claude Code session start

PROJECT_ROOT="$HOME/Developer/Projects/claude-code-buddy"
HEALTH_CHECK="$PROJECT_ROOT/scripts/health-check.js"
AUTO_REPAIR="$PROJECT_ROOT/scripts/auto-repair.js"

# Skip if not in dev mode
if [ ! -f "$HEALTH_CHECK" ]; then
  exit 0
fi

# Run health check
if ! node "$HEALTH_CHECK" --silent; then
  echo "🔧 MeMesh plugin needs repair..."
  if node "$AUTO_REPAIR" --silent; then
    echo "✅ Plugin repaired successfully"
  else
    echo "❌ Auto-repair failed. Run: cd $PROJECT_ROOT && npm run build"
  fi
fi
```

## Implementation Plan

### Phase 1: Core Health Check
1. Create `scripts/health-check.js`
2. Implement all 4 path checks
3. Test with various broken states
4. Document exit codes and output format

### Phase 2: Auto-Repair Logic
1. Create `scripts/auto-repair.js`
2. Implement repair actions for each path
3. Add backup/restore logic
4. Test repair on all failure modes

### Phase 3: Integration
1. Create SessionStart hook
2. Test hook integration
3. Verify no performance impact (< 500ms)
4. Document for users

### Phase 4: Monitoring & Logging
1. Add repair event logging
2. Track repair success rate
3. Alert on repeated repairs (indicates deeper issue)

## Testing Strategy

### Test Cases
1. **Fresh install**: All paths missing
2. **Partial install**: Some paths exist, some missing
3. **Corrupted files**: Invalid JSON, wrong values
4. **Broken symlink**: Points to non-existent location
5. **Wrong versions**: Mismatched version numbers
6. **Permission issues**: Files not writable

### Test Execution
```bash
# Simulate each failure mode
npm run test:health-check -- --simulate missing-marketplace
npm run test:health-check -- --simulate broken-symlink
npm run test:health-check -- --simulate corrupted-settings

# Verify auto-repair
npm run test:auto-repair
```

## Success Metrics
- **Zero manual interventions**: Plugin always auto-repairs
- **Fast execution**: Health check < 100ms, repair < 2s
- **No false positives**: Only repair when actually broken
- **User transparency**: Repairs happen silently, log for debugging

## Future Enhancements
1. **Remote health check**: API endpoint to verify installation
2. **Telemetry**: Anonymous usage stats for repair events
3. **Self-update**: Auto-update plugin when new version available
4. **Diagnostic tool**: Interactive CLI for manual diagnosis

## References
- `scripts/prepare-plugin.js`: Full installation logic
- `scripts/pre-deployment-check.sh`: Version consistency checks
- CLAUDE.md: MeMesh/CCB MCP health check requirements
