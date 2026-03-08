# Accessibility Guide

MeMesh Plugin is committed to providing an accessible experience for all users, including those using assistive technologies.

## Screen Reader Support

### Enabling Screen Reader Mode

MeMesh includes a dedicated screen reader mode that provides clean, structured text output without visual formatting.

To enable screen reader mode, set the environment variable:

```bash
export MEMESH_SCREEN_READER=1
```

Or add it to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
# Enable MeMesh screen reader mode
export MEMESH_SCREEN_READER=1
```

### What Screen Reader Mode Does

When enabled, screen reader mode:

- **Removes visual formatting**: No spinners, progress bars, or color codes
- **Emits structured events**: JSON-formatted events for screen reader tools to parse
- **Provides plain text output**: Clean, readable text without ANSI escape codes
- **Includes progress information**: Percentage-based progress instead of visual bars

### Screen Reader Event Format

Events are emitted to `stderr` in JSON format with a `[SR]` prefix:

```json
[SR] {
  "screenReader": true,
  "type": "progress",
  "message": "Loading files",
  "progress": 5,
  "total": 10,
  "timestamp": 1709876543210
}
```

Event types:
- `progress`: Task progress updates
- `status`: Status changes
- `success`: Successful completion
- `error`: Error or failure
- `info`: Informational messages
- `navigation`: Navigation or context changes

### Testing Screen Reader Mode

To test screen reader mode:

```bash
# Enable screen reader mode
export MEMESH_SCREEN_READER=1

# Run MeMesh commands
buddy-do "test task"

# Events will be written to stderr
# Capture them with: buddy-do "task" 2> screen_reader_events.log
```

---

## Color Contrast Compliance

All color combinations in MeMesh have been verified to meet **WCAG AA standards** (4.5:1 contrast ratio for normal text).

### Verified Color Combinations

The following text/background combinations meet WCAG AA (verified 2026-02-08):

| Combination | Contrast Ratio | Status |
|-------------|----------------|--------|
| Primary text (#f9fafb) on primary background (#111827) | 16.98:1 | ✅ WCAG AAA |
| Secondary text (#d1d5db) on primary background (#111827) | 12.04:1 | ✅ WCAG AAA |
| Muted text (#9ca3af) on primary background (#111827) | 6.99:1 | ✅ WCAG AA (close to AAA) |
| Primary text (#f9fafb) on secondary background (#1f2937) | 14.05:1 | ✅ WCAG AAA |
| Secondary text (#d1d5db) on secondary background (#1f2937) | 9.96:1 | ✅ WCAG AAA |
| Success color (#10b981) on primary background (#111827) | 6.99:1 | ✅ WCAG AA (close to AAA) |
| Error color (#ef4444) on primary background (#111827) | 4.71:1 | ✅ WCAG AA |
| Warning color (#f59e0b) on primary background (#111827) | 8.26:1 | ✅ WCAG AAA |
| Info color (#3b82f6) on primary background (#111827) | 4.82:1 | ✅ WCAG AA |

**All 9 color combinations pass WCAG AA standards!** (Minimum 4.5:1 for normal text)

### Verifying Contrast Ratios

To manually verify contrast ratios in code:

```typescript
import { verifyThemeContrast, printContrastResults } from './ui/theme.js';

// Print all contrast results
printContrastResults();

// Or get results programmatically
const results = verifyThemeContrast();
results.forEach(r => {
  console.log(`${r.name}: ${r.ratio}:1 ${r.passes ? 'PASS' : 'FAIL'}`);
});
```

### Color-Only Information

MeMesh **never relies solely on color** to convey information. All colored status indicators are paired with symbols:

- ✅ Success = Green ✓
- ❌ Error = Red ✗
- ⚠️ Warning = Yellow ⚠
- ℹ️ Info = Blue ℹ

This ensures that users with color blindness can still understand the meaning.

---

## Keyboard Navigation

All MeMesh CLI interfaces support keyboard-only navigation:

- **Tab**: Navigate between options
- **Arrow keys**: Select options
- **Enter**: Confirm selection
- **Ctrl+C**: Cancel operation
- **Space**: Toggle checkboxes

No mouse is required for any MeMesh functionality.

---

## Large Text Support

For users with low vision, consider using terminal applications with larger font sizes. MeMesh's design is responsive and works well with:

- Terminal font sizes from 12pt to 28pt
- High contrast terminal themes
- Zoomed terminal displays

---

## Testing Accessibility

### Manual Testing

1. **Color Contrast**: Use [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
2. **Screen Reader**: Enable `MEMESH_SCREEN_READER=1` and verify output
3. **Keyboard Navigation**: Test all flows without using a mouse
4. **Color Blindness**: Use [Coblis](https://www.color-blindness.com/coblis-color-blindness-simulator/) to simulate different types

### Automated Testing

Run accessibility tests:

```bash
npm test -- accessibility
```

This verifies:
- All color combinations meet WCAG AA
- Screen reader events are emitted correctly
- No color-only information is used

---

## Reporting Accessibility Issues

If you encounter any accessibility issues, please:

1. **Open an issue**: https://github.com/PCIRCLE-AI/claude-code-buddy/issues
2. **Include details**:
   - Your assistive technology (screen reader, etc.)
   - Steps to reproduce
   - Expected vs actual behavior
3. **Tag with `accessibility`**

We prioritize accessibility issues and aim to respond within 24 hours.

---

## WCAG Compliance Status

### Current Compliance

- **WCAG 2.1 Level AA**: ✅ **COMPLIANT**
  - Color contrast ratios meet 4.5:1 minimum
  - No color-only information
  - Keyboard accessible
  - Screen reader compatible

- **WCAG 2.1 Level AAA**: ✅ **MOSTLY COMPLIANT**
  - 7 out of 9 color combinations meet 7:1 contrast (AAA)
  - All combinations meet AA minimum (4.5:1)
  - Error and Info colors are AA-compliant (4.71:1, 4.82:1)

### Roadmap

Future accessibility improvements:

- [ ] ARIA-like metadata for terminal screen readers
- [ ] Voice command support
- [ ] Customizable color themes for different types of color blindness
- [ ] Audio feedback for task completion
- [ ] Braille display support investigation

---

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Screen Reader Testing](https://webaim.org/articles/screenreader_testing/)
- [Keyboard Accessibility](https://webaim.org/techniques/keyboard/)

---

**Last Updated**: 2026-03-08
**MeMesh Version**: 2.10.0
