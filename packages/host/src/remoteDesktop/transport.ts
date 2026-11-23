import { encodeControl, encodeEnvelope, type DesktopPacket } from '@termbridge/protocol';

type DesktopTransport = {
  readyState: number;
  send(data: Buffer, callback: (error?: Error) => void): void;
};

/** Await each write so large RFB rectangles cannot overflow the relay's send queue. */
export function sendDesktopPacket(transport: DesktopTransport, clientId: number, packet: DesktopPacket): Promise<void> {
  if (transport.readyState !== 1) return Promise.reject(new Error('Desktop transport disconnected'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop transport stalled')), 10_000);
    timer.unref();
    try {
      transport.send(encodeEnvelope(clientId, encodeControl(packet)), error => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
