import SwiftUI
import UIKit
import VisionKit

struct PairingImportView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var code = ""
  @State private var error: String?
  @State private var showingScanner = false

  let onImport: () -> Void

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextEditor(text: $code)
            .font(.system(.body, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .frame(minHeight: 110)
          Button("Paste connection code", systemImage: "doc.on.clipboard") {
            code = UIPasteboard.general.string ?? ""
          }
          Button("Scan QR code", systemImage: "qrcode.viewfinder") {
            showingScanner = true
          }
          .disabled(!QRCodeScannerView.isAvailable)
        } header: {
          Text("Cloudflare pairing")
        } footer: {
          Text("Scan the QR printed by `tb cloudflare pair`, or paste its connection code or pairing URI.")
        }

        if let error {
          Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
        }
      }
      .navigationTitle("Pair a Mac")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Import", action: importCode).fontWeight(.semibold).disabled(code.isEmpty)
        }
      }
      .sheet(isPresented: $showingScanner) {
        QRCodeScannerView { scanned in
          code = scanned
          showingScanner = false
          importCode()
        }
        .ignoresSafeArea()
      }
    }
  }

  private func importCode() {
    do {
      SettingsStore.save(try PairingCode.parse(code))
      error = nil
      onImport()
      dismiss()
    } catch {
      self.error = error.localizedDescription
    }
  }
}

struct QRCodeScannerView: UIViewControllerRepresentable {
  static var isAvailable: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }

  let onScan: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
      recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    DispatchQueue.main.async { try? scanner.startScanning() }
    return scanner
  }

  func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let onScan: (String) -> Void
    private var delivered = false
    init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

    func dataScanner(
      _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      guard !delivered else { return }
      for item in addedItems {
        guard case .barcode(let barcode) = item,
          let payload = barcode.payloadStringValue else { continue }
        delivered = true
        dataScanner.stopScanning()
        onScan(payload)
        return
      }
    }
  }
}
