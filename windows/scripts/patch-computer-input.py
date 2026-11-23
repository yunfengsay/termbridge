"""Windows-MCP 0.8.5 compatibility fix: avoid per-key Unicode races on Windows ARM.
Type is literal text; Shortcut remains the explicit key-chord tool.
"""
import pathlib,sys
site=pathlib.Path(sys.argv[1])
path=site/'windows_mcp/desktop/service.py'
source=path.read_text(encoding='utf-8')
before='if len(text) >= self._LONG_TEXT_PASTE_THRESHOLD and not has_control_chars:'
after='if len(text) >= self._LONG_TEXT_PASTE_THRESHOLD or any(ord(c) > 127 or c in "\\n\\t" for c in text):'
if before in source:
 source=source.replace(before,after,1)
 source=source.replace('        has_control_chars = any(c in text for c in ("\\n", "\\t", "{", "}"))\n','')
 source=source.replace('        # Per-key SendKeys for short text (so escape sequences keep working);\n        # clipboard paste for long text (so the scan-code queue can\'t race).','        # Clipboard typing preserves Unicode and multiline text on Windows ARM.\n        # Short ASCII text can continue through the existing escaped-key path.')
 source=source.replace('        Plain-text only — control chars (newlines, tabs, braces) need to\n        route through SendKeys instead so escape sequences are honored.','        Type accepts literal text, including newlines and Unicode.')
 path.write_text(source,encoding='utf-8')
elif after not in source:raise RuntimeError('Windows-MCP Type implementation changed; review the input patch')
print('Windows-MCP literal Unicode input patch verified')
