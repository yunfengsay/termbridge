# Third-party software

The native application uses Microsoft Windows App SDK / WinUI 3, WebView2 SDK and .NET. Their license and third-party notice files are included by the self-contained publish output. WebView2 Evergreen Runtime is a Microsoft component, installed from Microsoft when absent.

The terminal includes xterm.js and its fit addon under the MIT license (`TermBridge.App/Terminal/LICENSE-xterm`).

The offline runtime includes Node.js 24.20.0 (Node.js and bundled dependency licenses under `runtime/node`), Python 3.13.7 (PSF license under `runtime/python`), TermBridge CLI, and Windows-MCP 0.8.5 with its Python dependencies. Exact Python versions and distribution hashes are pinned in `requirements-windows.txt`; wheel license metadata remains in `runtime/python/Lib/site-packages/*.dist-info`.

Runtime download identities and hashes are recorded in `runtime/manifest.json`. A local CLI bridge build additionally carries `runtime/native-cli.json`; it is not represented as a published npm version.

The application shell contains no Electron runtime. NSIS is used only to generate the installer.

Windows-MCP 0.8.5 includes a local compatibility change for literal Unicode and multiline typing through the clipboard. The reproducible patch is in `scripts/patch-computer-input.py`; its applied source hash is recorded in `runtime/compatibility-patches.json`.

## Orca (Agent conversation view)

The shared Agent conversation view (`TermBridge.App/Chat/chat.js`) includes adaptations of Orca `src/shared/native-chat-types.ts` and `src/shared/native-chat-merge.ts`, via `packages/agent-chat/src/types.ts` and `merge.ts`, at revision `55b33920180efa188a19dfb7fac0fc993f10a922` (<https://github.com/stablyai/orca>). The bundled Host includes additional adaptations documented in `runtime/tb/THIRD_PARTY_NOTICES.md`.

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
