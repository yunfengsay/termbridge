// Disposable wire peer for native macOS input/scroll acceptance. No real panes.
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const { pack, unpack } = createRequire(new URL('../../packages/protocol/package.json', import.meta.url))('msgpackr');

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
const control = (ws, msg) => ws.send(Buffer.concat([Buffer.from([0]), pack(msg)]));
const screen = (ws, text) => ws.send(Buffer.concat([Buffer.from([1, 0, 1]),
  Buffer.from('\x1b[2J\x1b[H' + text)]));
server.on('listening', () => writeFileSync(process.argv[2], String(server.address().port)));
server.on('connection', ws => {
  let native = false;
  let codex = false, cols = 80, rows = 24, offset = 0;
  const codexScreen = () => {
    const body = `NEW_ACTIVITY\r\nSIZE:${cols}x${rows}\r\nHISTORY_OFFSET:${offset}`;
    // Native frames preserve geometry and the input cursor after the footer.
    // A compatible visible snapshot only has text in the source pane's size.
    screen(ws, native
      ? `${body}\x1b[${rows - 3};1HINPUT> \x1b[${rows};1HFOOTER\x1b[${rows - 3};8H`
      : body + '\r\n'.repeat(57) + 'FOOTER');
  };
  control(ws, { t: 'auth_challenge', nonce: 'disposable-scroll-test', required: false });
  ws.on('message', raw => {
    if (raw[0] === 0) {
      const msg = unpack(raw.subarray(1));
      if (msg.t === 'attach') {
        codex = msg.sessionId.endsWith(':codex-history');
        native = (codex && msg.nativeTerminal === true) || msg.sessionId.endsWith(':native') || msg.sessionId.endsWith(':native-history');
        cols = msg.cols; rows = msg.rows;
        control(ws, { t: 'attach_ok', sessionId: msg.sessionId, sid: 1,
          nativeTerminal: native, historyScroll: !native });
        if (codex) { codexScreen(); return; }
        screen(ws, '\x1b[?1h' + (msg.sessionId.endsWith(':native') ? '\x1b[?1000h\x1b[?1006h' : '') + 'NEW_ACTIVITY');
      } else if (msg.t === 'session_scroll') {
        if (codex) {
          offset = Math.max(0, Math.min(5000, offset + (msg.direction === 'up' ? msg.lines : -msg.lines)));
          codexScreen(); return;
        }
        screen(ws, msg.direction === 'up' ? 'HISTORY_TOP' : 'HISTORY_BOTTOM');
      }
    } else if (raw[0] === 3 && native && codex) {
      cols = raw.readUInt16BE(3); rows = raw.readUInt16BE(5); codexScreen();
    } else if (raw[0] === 2) {
      const input = raw.subarray(3).toString();
      // Emulate an older compatible Host: only CSI arrows are recognized.
      if (input === (native ? '\x1bOB' : '\x1b[B')) screen(ws, 'KEY_AT_BOTTOM');
      else if (native && /\x1b\[<65;\d+;\d+M/.test(input)) screen(ws, 'WHEEL_AT_BOTTOM');
      else screen(ws, 'UNRECOGNIZED_INPUT');
    }
  });
});
const close = () => { for (const ws of server.clients) ws.terminate(); server.close(() => process.exit(0)); };
process.on('SIGTERM', close);
process.on('SIGINT', close);
