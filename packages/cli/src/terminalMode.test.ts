import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  terminalEnterSequence,
  terminalExitSequence,
  terminalOutputSuffix,
} from './terminalMode.js';

describe('Herdr CLI terminal mode', () => {
  it('enables bracketed paste without overriding native cursor visibility', () => {
    assert.equal(terminalEnterSequence('herdr:wA:p1'), '\x1b[?1049h\x1b[?2004h');
    assert.equal(terminalOutputSuffix('herdr:wA:p1'), '');
  });

  it('restores bracketed paste mode when detaching', () => {
    assert.equal(terminalExitSequence('herdr:wA:p1'), '\x1b[?2004l\x1b[?25h\x1b[?1049l');
  });

  it('does not override terminal modes for owned PTY sessions', () => {
    assert.equal(terminalEnterSequence('pty:123'), '');
    assert.equal(terminalOutputSuffix('pty:123'), '');
    assert.equal(terminalExitSequence('pty:123'), '');
  });
});
