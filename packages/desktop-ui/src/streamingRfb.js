import RFB from '@novnc/novnc';
/** noVNC 1.7 adapter: this boundary follows ServerInit and precedes SetEncodings / the first update.
 * Keep its ordering covered by the real-RFB integration test when upgrading noVNC.
 */
export default class StreamingRfb extends RFB {
  _framebufferUpdate() {
    const complete = super._framebufferUpdate();
    if (complete && this.onDesktopFrame) {
      // JPEG decoding/painting is asynchronous. Do not release viewport refresh
      // backpressure when bytes merely arrived in the WebView.
      void this._display.flush().then(() => this.onDesktopFrame?.());
    }
    return complete;
  }
  _sendEncodings() {
    if (!this.desktopInitialized) {
      this.desktopInitialized = true;
      this.onDesktopInit?.(this._fbWidth, this._fbHeight);
    }
    super._sendEncodings();
  }
}
