# Third-party notices

## Agent conversation surface

The packaged `app/src/main/assets/agent-chat/chat.js` includes shared conversation
types and merging code adapted from [Orca](https://github.com/stablyai/orca),
revision `55b33920180efa188a19dfb7fac0fc993f10a922`.

Copyright (c) 2026 Lovecast Inc. Licensed under MIT. The full notice and license
are included in the APK at `assets/agent-chat/THIRD_PARTY_NOTICES.md`.

## Terminal

The Android application bundles the following MIT-licensed terminal components:

- `@xterm/xterm` 6.0.0
- `@xterm/addon-fit` 0.11.0

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)

Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

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

## On-device voice protection

The Android application bundles sherpa-onnx 1.13.6, Silero VAD, GTCRN speech
denoising (`gtcrn_simple.onnx`), a 3D-Speaker CAMPPlus Chinese
speaker-verification model (`3dspeaker_campplus_zh.onnx`), and a Chinese
keyword-spotting model (`wake-word-zh-3m/`). These components are used only for
local denoising, wake-word detection, voice-activity and enrolled-speaker
checks; speech transcription remains a host-side service.

The bundled sherpa-onnx AAR contains only its official arm64-v8a JNI and ONNX
Runtime libraries; unused desktop-emulator and 32-bit Android ABIs were removed.

- sherpa-onnx: Apache-2.0, https://github.com/k2-fsa/sherpa-onnx
- Silero VAD: MIT, https://github.com/snakers4/silero-vad
- GTCRN (`gtcrn_simple.onnx`): MIT (exported via sherpa-onnx), https://github.com/Xiaobin-Rong/gtcrn
- 3D-Speaker: Apache-2.0, https://github.com/modelscope/3D-Speaker
- sherpa-onnx-kws-zipformer-wenetspeech-3.3M (`wake-word-zh-3m/`): Apache-2.0, see `app/src/main/assets/wake-word-zh-3m/LICENSE`

The complete license texts are included at `licenses/Apache-2.0.txt`,
`licenses/MIT-Silero.txt`, and `app/src/main/assets/wake-word-zh-3m/LICENSE`.
