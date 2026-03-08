# MeMesh Plugin Configuration Management

The `memesh config` command provides utilities for managing your MeMesh configuration.

## Commands

### `memesh config show`

Display the current MeMesh configuration with syntax highlighting.

**Usage:**
```bash
memesh config show
```

**Output:**
- Configuration file location (platform-specific)
- Full configuration with syntax highlighting
- MeMesh server details and status
- Executable path verification

**Example:**
```bash
$ memesh config show

⚙️  MeMesh Configuration

📍 Configuration File:
   ~/Library/Application Support/Claude/claude_desktop_config.json

📄 Configuration:

{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/@pcircle/memesh/dist/mcp/server-bootstrap.js"],
      "env": {}
    }
  }
}

🔧 MeMesh Server:
   Command:   node
   Script:    /usr/local/lib/node_modules/@pcircle/memesh/dist/mcp/server-bootstrap.js
   Status:    ✓ Installed
```

---

### `memesh config validate`

Validate the MCP configuration and test the connection.

**Usage:**
```bash
memesh config validate
```

**Validation Checks:**
- Configuration file exists
- Valid JSON syntax
- MeMesh MCP server is configured
- Required fields (`command`, `args`) are present
- Executable path exists
- Configuration structure is correct

**Output:**
- Validation results (errors and warnings)
- MeMesh server configuration details
- Next steps for fixing issues

**Example (Valid Configuration):**
```bash
$ memesh config validate

🔍 Configuration Validation

📍 Configuration File:
   /Users/username/Library/Application Support/Claude/claude_desktop_config.json

✅ Configuration is valid!

🔧 MeMesh Server Configuration:
   Command:   node
   Script:    /usr/local/lib/node_modules/@pcircle/memesh/dist/mcp/server-bootstrap.js

✓ Next Steps:

1. Restart Claude Code to load MeMesh
2. Verify connection: type "buddy-help" in Claude Code
3. Test features: try "buddy-do" or "buddy-remember"
```

**Example (Invalid Configuration):**
```bash
$ memesh config validate

🔍 Configuration Validation

📍 Configuration File:
   /Users/username/Library/Application Support/Claude/claude_desktop_config.json

❌ Configuration has errors:

   • MeMesh MCP server not configured

🔧 Fix Configuration:

Run: memesh setup to reconfigure
Or: memesh config edit to edit manually
```

---

### `memesh config edit`

Open the configuration file in your default editor.

**Usage:**
```bash
memesh config edit
```

**Features:**
- Automatically creates a backup before editing
- Opens in your default editor (respects `$EDITOR` and `$VISUAL`)
- Validates configuration after editing
- Shows validation results and any errors

**Default Editors by Platform:**
- **macOS**: TextEdit (`open -e`)
- **Windows**: Notepad
- **Linux**: nano

**Environment Variables:**
You can override the default editor by setting:
```bash
export EDITOR=vim
export VISUAL=code
```

**Example:**
```bash
$ memesh config edit

✏️  Edit Configuration

📍 Configuration File:
   /Users/username/Library/Application Support/Claude/claude_desktop_config.json

📦 Backup created: claude_desktop_config.json.backup-2026-02-03T12-00-00-000Z

Opening configuration in editor...

✅ Configuration saved

Validating configuration...

✅ Configuration is valid
```

---

### `memesh config reset`

Reset the configuration to default values.

**Usage:**
```bash
memesh config reset
```

**Features:**
- Confirmation prompt before resetting
- Creates automatic backup
- Generates default MeMesh configuration
- Shows new configuration after reset

**Warning:** This will overwrite your current configuration. A backup is created automatically.

**Example:**
```bash
$ memesh config reset

🔄 Reset Configuration

📍 Configuration File:
   /Users/username/Library/Application Support/Claude/claude_desktop_config.json

? Are you sure you want to reset configuration to defaults? Yes

✅ Backup created: claude_desktop_config.json.backup-2026-02-03T12-00-00-000Z

✅ Configuration reset to defaults

📄 New Configuration:

{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/usr/local/lib/node_modules/@pcircle/memesh/dist/mcp/server-bootstrap.js"],
      "env": {}
    }
  }
}

✓ Next Steps:

1. Restart Claude Code to apply changes
2. Verify: type "buddy-help" in Claude Code
```

---

## Configuration File Locations

### macOS
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

### Windows
```
%APPDATA%\Claude\claude_desktop_config.json
```
Typically: `C:\Users\<username>\AppData\Roaming\Claude\claude_desktop_config.json`

### Linux
```
~/.config/Claude/claude_desktop_config.json
```

---

## Configuration Structure

### Minimal Valid Configuration

```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/path/to/memesh/dist/mcp/server-bootstrap.js"],
      "env": {}
    }
  }
}
```

### Configuration with Environment Variables

```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/path/to/memesh/dist/mcp/server-bootstrap.js"],
      "env": {
        "DEBUG": "memesh:*",
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Multiple MCP Servers

```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/path/to/memesh/dist/mcp/server-bootstrap.js"],
      "env": {}
    },
    "other-server": {
      "command": "npx",
      "args": ["other-mcp-server"],
      "env": {}
    }
  }
}
```

---

## Common Issues and Solutions

### Issue: "Configuration file does not exist"

**Solution:**
Run the setup wizard first:
```bash
memesh setup
```

### Issue: "Invalid JSON syntax"

**Solution:**
1. Use `memesh config edit` to fix the JSON
2. Validate syntax using a JSON validator
3. Or reset to defaults: `memesh config reset`

Common JSON errors:
- Missing commas between properties
- Trailing commas before closing braces
- Unquoted keys or values
- Missing quotes around strings

### Issue: "MeMesh MCP server not configured"

**Solution:**
1. Run `memesh setup` to configure automatically
2. Or manually add the memesh server configuration

### Issue: "MeMesh executable not found"

**Solution:**
The configured path doesn't exist. This usually means:
1. MeMesh is not installed globally: `npm install -g @pcircle/memesh`
2. The path in the configuration is incorrect
3. Run `memesh setup` to detect the correct path

### Issue: Configuration changes not taking effect

**Solution:**
1. Restart Claude Code completely (quit and reopen)
2. Verify configuration: `memesh config validate`
3. Check Claude Code logs for errors

---

## Tips and Best Practices

### 1. Always Validate After Editing

After manually editing the configuration, always run:
```bash
memesh config validate
```

### 2. Keep Backups

Configuration backups are created automatically when you:
- Edit with `memesh config edit`
- Reset with `memesh config reset`

Backup file format:
```
claude_desktop_config.json.backup-2026-02-03T12-00-00-000Z
```

### 3. Use Environment Variables for Debugging

Enable debug logging:
```json
{
  "mcpServers": {
    "memesh": {
      "command": "node",
      "args": ["/path/to/memesh/dist/mcp/server-bootstrap.js"],
      "env": {
        "DEBUG": "memesh:*"
      }
    }
  }
}
```

### 4. Version Control Your Configuration

Consider backing up your configuration to version control:
```bash
# Backup to a safe location
cp ~/Library/Application\ Support/Claude/claude_desktop_config.json ~/backups/

# Or add to your dotfiles repository
```

---

## Troubleshooting

### View Configuration
```bash
memesh config show
```

### Validate Configuration
```bash
memesh config validate
```

### Fix Configuration Issues
```bash
# Option 1: Reset to defaults
memesh config reset

# Option 2: Reconfigure with wizard
memesh setup

# Option 3: Edit manually
memesh config edit
```

### Check Logs

Claude Code logs are usually located at:
- **macOS**: `~/Library/Logs/Claude Code/`
- **Windows**: `%APPDATA%\Claude Code\logs\`
- **Linux**: `~/.config/Claude Code/logs/`

---

## Related Commands

- `memesh setup` - Interactive configuration wizard
- `memesh tutorial` - Interactive 5-minute tutorial
- `memesh dashboard` - View session health dashboard

---

## Support

If you encounter issues:

1. Run `memesh config validate` to identify problems
2. Check the [GitHub Issues](https://github.com/PCIRCLE-AI/claude-code-buddy/issues)
3. Report new issues with `memesh report-issue`
4. Join discussions on [GitHub Discussions](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)
