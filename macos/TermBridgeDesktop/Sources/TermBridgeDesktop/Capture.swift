import AppKit
import ScreenCaptureKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

func jpeg(_ image: CGImage, quality: Double = 0.7) throws -> Data {
    let bytes = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw DesktopFailure("JPEG encoder unavailable")
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw DesktopFailure("JPEG encoding failed") }
    return bytes as Data
}

/// One frame may be outstanding. Host acknowledges it after downstream consumption.
final class DesktopFrameSink: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private var active = true
    private var pending = false
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let emit: (CGImage) -> Void
    init(emit: @escaping (CGImage) -> Void) { self.emit = emit }
    func acknowledge() { lock.lock(); pending = false; lock.unlock() }
    func stop() { lock.lock(); active = false; lock.unlock() }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let buffer = sample.imageBuffer else { return }
        lock.lock(); let eligible = active && !pending; if eligible { pending = true }; lock.unlock()
        guard eligible else { return }
        let ci = CIImage(cvPixelBuffer: buffer)
        guard let image = context.createCGImage(ci, from: ci.extent) else { acknowledge(); return }
        // No shared-state lock is held while encoding/writing to the Host pipe.
        emit(image)
    }
}

final class DesktopStreamDelegate: NSObject, SCStreamDelegate {
    let stopped: () -> Void
    init(stopped: @escaping () -> Void) { self.stopped = stopped }
    func stream(_ stream: SCStream, didStopWithError error: Error) { stopped() }
}

@MainActor final class DesktopCapture {
    private var stream: SCStream?
    private var sink: DesktopFrameSink?
    private var delegate: DesktopStreamDelegate?
    private(set) var geometry: DesktopGeometry?
    private(set) var generation = 0

    func displays() -> [[String: Any]] {
        NSScreen.screens.compactMap { screen in
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            let id = number.uint32Value, b = CGDisplayBounds(id)
            return ["id": id, "name": screen.localizedName, "x": b.minX, "y": b.minY,
                    "width": b.width, "height": b.height, "pixelWidth": CGDisplayPixelsWide(id),
                    "pixelHeight": CGDisplayPixelsHigh(id), "main": id == CGMainDisplayID()]
        }
    }

    private func configuration(displayID: UInt32?, maxWidth: Int, fps: Int) async throws -> (SCContentFilter, SCStreamConfiguration, SCDisplay) {
        guard CGPreflightScreenCaptureAccess() else { throw DesktopFailure("Screen Recording permission is required for TermBridge Desktop") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == (displayID ?? CGMainDisplayID()) }) else {
            throw DesktopFailure("No shareable display. Unlock the Mac and check Screen Recording permission, then reconnect")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        let pixels = max(1, CGDisplayPixelsWide(display.displayID)), height = max(1, CGDisplayPixelsHigh(display.displayID))
        config.width = min(pixels, maxWidth)
        config.height = max(1, Int(Double(height) * Double(config.width) / Double(pixels)))
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.queueDepth = 3; config.showsCursor = true; config.capturesAudio = false
        return (filter, config, display)
    }

    func snapshot(displayID: UInt32?, maxWidth: Int) async throws -> [String: Any] {
        let requestedGeneration = generation
        let (filter, config, display) = try await configuration(displayID: displayID, maxWidth: maxWidth, fps: 1)
        guard generation == requestedGeneration else { throw DesktopFailure("Desktop capture cancelled") }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        guard generation == requestedGeneration else { throw DesktopFailure("Desktop capture cancelled") }
        return ["displayId": display.displayID, "width": image.width, "height": image.height,
                "mime": "image/jpeg", "data": try jpeg(image).base64EncodedString()]
    }

    func start(displayID: UInt32?, maxWidth: Int, fps: Int, emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        let requestedGeneration = generation + 1
        await stop()
        guard generation == requestedGeneration else { throw DesktopFailure("Desktop capture cancelled") }
        let (filter, config, display) = try await configuration(displayID: displayID, maxWidth: maxWidth, fps: fps)
        guard generation == requestedGeneration else { throw DesktopFailure("Desktop capture cancelled") }
        generation += 1
        let gen = generation
        geometry = DesktopGeometry(displayID: display.displayID, bounds: CGDisplayBounds(display.displayID))
        let output = DesktopFrameSink { image in
            do {
                let bytes = try jpeg(image)
                emit(["event": "frame", "generation": gen, "displayId": display.displayID,
                      "width": image.width, "height": image.height, "mime": "image/jpeg", "data": bytes.base64EncodedString()])
            } catch { emit(["event": "error", "generation": gen, "error": String(describing: error)]) }
        }
        let delegate = DesktopStreamDelegate { emit(["event": "error", "generation": gen, "error": "Screen capture stopped; unlock the Mac and check permission"]) }
        let next = SCStream(filter: filter, configuration: config, delegate: delegate)
        try next.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "tb.desktop.frames", qos: .userInitiated))
        stream = next; sink = output; self.delegate = delegate
        do { try await next.startCapture() } catch { await stop(); throw error }
        guard generation == gen else { try? await next.stopCapture(); throw DesktopFailure("Desktop capture cancelled") }
        return ["generation": gen, "displayId": display.displayID, "width": config.width, "height": config.height]
    }

    func acknowledge(_ value: Int) { if value == generation { sink?.acknowledge() } }
    func stop() async {
        generation += 1
        let old = stream; sink?.stop(); stream = nil; sink = nil; geometry = nil
        try? await old?.stopCapture()
        delegate = nil
    }
}
