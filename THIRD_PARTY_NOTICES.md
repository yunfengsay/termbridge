# Third-party notices

## noVNC

The desktop viewer embeds unmodified noVNC 1.7.0, primarily under MPL-2.0.
Upstream: https://github.com/novnc/noVNC/tree/v1.7.0
Each shipped desktop viewer includes `THIRD_PARTY_LICENSES.txt` and
`novnc-source/`, containing the exact corresponding source, AUTHORS and notices
(including the separately licensed vendor code). TermBridge's transport and
touch viewport are separate source files in `packages/desktop-ui/src/`.

## parse-diff

The bundled Host uses `parse-diff` 0.12.0.

The MIT License (MIT)

Copyright (c) 2014 Sergey Todyshev

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Markwon syntax-highlight and Prism4j

The Android Git Review screen uses `io.noties.markwon:syntax-highlight` 4.6.2
and `io.noties:prism4j` 2.0.0 for native `Spannable` syntax highlighting.

Copyright 2017-2023 Dimitry Ivanov and Markwon contributors.
Copyright 2019 Dimitry Ivanov.

Licensed under the Apache License, Version 2.0. You may obtain a copy at
<https://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.

## vscode-icons

The Android Git Review file and folder vectors are adapted from `vscode-icons`.

Copyright (c) 2016 Roberto Huertas.

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## marked

The shared Agent Chat renderer parses Markdown with `marked` 18.0.13, bundled
into the `chat.js` that each native shell ships. The package's own licence file
travels with it verbatim as `THIRD_PARTY_LICENSES.md` in the same resource
folder, generated from the installed package by
`packages/agent-chat-ui/scripts/build-webview.mjs`; that file is authoritative
and also carries the original Markdown notice (Copyright © 2004 John Gruber)
that `marked` reproduces. Its own terms are MIT:

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Orca (native chat)

The Agent conversation mode adapts source from Orca at revision
`55b33920180efa188a19dfb7fac0fc993f10a922`
(<https://github.com/stablyai/orca>). The derived files name their origin in a
header comment:

- `packages/agent-chat/src/types.ts` — from `src/shared/native-chat-types.ts`
- `packages/agent-chat/src/merge.ts` — from `src/shared/native-chat-merge.ts`
- `packages/agent-chat/src/decoders/blocks.ts` — from
  `src/main/native-chat/transcript-record-blocks.ts`
- `packages/agent-chat/src/decoders/claude.ts` — from
  `src/main/native-chat/transcript-line-decoders-claude.ts`
- `packages/agent-chat/src/decoders/codex.ts` — from
  `src/main/native-chat/transcript-line-decoders-codex.ts`
- `packages/host/src/agentChat/incrementalReader.ts` — from
  `src/main/native-chat/transcript-incremental-reader.ts`

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
