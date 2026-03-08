# Error Reference

Complete reference of MeMesh Plugin error types, codes, and solutions.

---

## Error Hierarchy

All MeMesh errors extend `BaseError` and include:
- **`code`**: Programmatic error code (see table below)
- **`context`**: Structured metadata about the error
- **`timestamp`**: When the error occurred

```
BaseError
├── ValidationError      (input validation failures)
├── StateError           (invalid state for operation)
├── NotFoundError        (resource not found)
├── ConfigurationError   (configuration issues)
├── OperationError       (operation execution failures)
└── ExternalServiceError (external API/service failures)
```

---

## Error Codes

### Validation Errors (VALIDATION_*)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `VALIDATION_FAILED` | `ValidationError` | "Memory content cannot be empty" | Empty or missing required field | Provide non-empty value for required fields |
| `VALIDATION_FAILED` | `ValidationError` | "Metrics store path must be within user home or data directory" | Path traversal attempt | Use paths within `~/.memesh/` or home directory |
| `VALIDATION_FAILED` | `ValidationError` | "Limit must be non-negative" | Negative number for pagination | Use positive integers for `limit` and `offset` |
| `VALIDATION_FAILED` | `ValidationError` | "Database path must be a non-empty string" | Empty database path | Provide a valid `.db` file path |
| `VALIDATION_FAILED` | `ValidationError` | "Database path contains invalid null byte" | Null byte injection attempt | Remove null bytes from path |
| `VALIDATION_FAILED` | `ValidationError` | "Database path must have .db extension" | Wrong file extension | Use `.db` extension for database files |
| `VALIDATION_FAILED` | `ValidationError` | "Database path must be within allowed directory" | Path outside allowed scope | Use paths within `~/.memesh/` |
| `VALIDATION_FAILED` | `ValidationError` | "CPU percentage must be between 0 and 100" | Out-of-range resource value | Use values within documented ranges |
| `VALIDATION_FAILED` | `ValidationError` | "Max background agents must be >= 1" | Invalid agent limit | Set at least 1 for max agents |
| `VALIDATION_FAILED` | `ValidationError` | "Memory ID must start with prefix: mem_" | Invalid ID format | Use IDs with `mem_` prefix |
| `VALIDATION_FAILED` | `ValidationError` | "Invalid memory type" | Unsupported memory type | Use: `decision`, `feature`, `bug_fix`, `lesson_learned`, `pattern`, `note` |
| `VALIDATION_FAILED` | `ValidationError` | "Command is required" | Empty tool command | Provide command string |
| `VALIDATION_FAILED` | `ValidationError` | "CSRF protection: Missing origin header" | Missing security header | Ensure Origin header is present |
| `VALIDATION_FAILED` | `ValidationError` | "Agent name must be a non-empty string" | Empty agent name | Provide non-empty agent name |

### State Errors (INVALID_STATE)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `INVALID_STATE` | `StateError` | "Memory system not initialized" | Using system before init | Call `initialize()` before operations |
| `ALREADY_INITIALIZED` | `StateError` | "System already initialized" | Double initialization | Check state before calling init |

### Not Found Errors (RESOURCE_NOT_FOUND)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `RESOURCE_NOT_FOUND` | `NotFoundError` | "Task not found" | Invalid task ID | Verify task ID with `memesh-metrics` |
| `ENTITY_NOT_FOUND` | `NotFoundError` | "Entity not found" | Knowledge graph entity missing | Use `buddy-remember` to search first |
| `TOOL_NOT_FOUND` | `NotFoundError` | "Tool not found" | Invalid MCP tool name | Check available tools with `buddy-help` |

### Configuration Errors (CONFIGURATION_*)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `CONFIGURATION_INVALID` | `ConfigurationError` | "API key is required" | Missing API key | Run `memesh login` or set `ANTHROPIC_API_KEY` |
| `CONFIGURATION_MISSING` | `ConfigurationError` | "Configuration file not found" | Missing config | Run `memesh setup` to create config |

### Operation Errors (OPERATION_*)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `OPERATION_FAILED` | `OperationError` | "Memory update failed" | Database write failure | Check disk space, file permissions |
| `OPERATION_FAILED` | `OperationError` | "Failed to create UnifiedMemoryStore" | Store initialization error | Check database file integrity |
| `OPERATION_FAILED` | `OperationError` | "Failed to store memory" | Write operation failed | Verify database is not locked |
| `INITIALIZATION_FAILED` | `OperationError` | "Tool dispatcher is not attached" | Missing component wiring | Restart MeMesh server |
| `EXECUTION_FAILED` | `OperationError` | "Tool execution failed" | Runtime tool error | Check tool input parameters |

### External Service Errors (EXTERNAL_*)

| Code | Error Class | Common Message | Cause | Solution |
|------|-------------|----------------|-------|----------|
| `EXTERNAL_SERVICE_ERROR` | `ExternalServiceError` | "External API request failed" | API call failed | Check network, API key validity |
| `NETWORK_ERROR` | `ExternalServiceError` | "Network request timed out" | Connection timeout | Retry, check connectivity |
| `TIMEOUT_ERROR` | `ExternalServiceError` | "Operation timed out" | Exceeded time limit | Increase timeout or reduce workload |

---

## SQLite-Specific Errors

These are native SQLite errors caught and wrapped by MeMesh:

| SQLite Error | MeMesh Handling | Cause | Solution |
|-------------|-----------------|-------|----------|
| `SQLITE_BUSY` | Retried with exponential backoff | Database locked by another process | Wait or kill other MeMesh processes: `npm run processes:kill` |
| `SQLITE_FULL` | Connection discarded from pool | Disk full | Free disk space, check `~/.memesh/` size |
| `SQLITE_CORRUPT` | Detected by `PRAGMA quick_check` | Database corruption | Delete `~/.memesh/database.db` and restart (data loss) |
| `SQLITE_READONLY` | `OperationError` thrown | File permissions | Fix: `chmod 644 ~/.memesh/database.db` |
| `SQLITE_IOERR` | Connection discarded | I/O failure | Check disk health, file system |

---

## Programmatic Error Handling

```typescript
import { isValidationError, isOperationError, getErrorCode, ErrorCode } from '@pcircle/memesh';

try {
  await store.createMemory(data);
} catch (error) {
  if (isValidationError(error)) {
    // Input validation failed — fix input
    console.log('Invalid field:', error.context);
  } else if (isOperationError(error)) {
    // Operation failed — retry or report
    console.log('Operation:', error.context?.operation);
  }

  // Or use error codes
  const code = getErrorCode(error);
  if (code === ErrorCode.VALIDATION_FAILED) { /* ... */ }
}
```

---

## Type Guards

| Function | Returns `true` for |
|----------|-------------------|
| `isBaseError(err)` | Any MeMesh custom error |
| `isValidationError(err)` | Input validation errors |
| `isStateError(err)` | State-related errors |
| `isNotFoundError(err)` | Resource not found errors |
| `isConfigurationError(err)` | Configuration errors |
| `isOperationError(err)` | Operation execution errors |
| `isExternalServiceError(err)` | External service errors |

---

**Version**: 2.10.0
**Last Updated**: 2026-03-08
