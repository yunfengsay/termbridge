import Foundation

enum IncomingFrame: Equatable {
  case control(ControlMessage)
  case ptyOutput(sid: Int, data: Data)
  case ptyInput(sid: Int, data: Data)
  case resize(sid: Int, cols: Int, rows: Int)

  static func == (lhs: IncomingFrame, rhs: IncomingFrame) -> Bool {
    switch (lhs, rhs) {
    case (.ptyOutput(let aSid, let aData), .ptyOutput(let bSid, let bData)),
      (.ptyInput(let aSid, let aData), .ptyInput(let bSid, let bData)):
      return aSid == bSid && aData == bData
    case (.resize(let aSid, let aCols, let aRows), .resize(let bSid, let bCols, let bRows)):
      return aSid == bSid && aCols == bCols && aRows == bRows
    case (.control(let a), .control(let b)):
      return a.fields == b.fields
    default:
      return false
    }
  }
}

enum FrameCodecError: Error, LocalizedError {
  case emptyFrame
  case shortFrame
  case unknownType(UInt8)
  case missingControlType

  var errorDescription: String? {
    switch self {
    case .emptyFrame: return "Empty Termbridge frame"
    case .shortFrame: return "Short Termbridge frame"
    case .unknownType(let type): return "Unknown Termbridge frame type \(type)"
    case .missingControlType: return "Control frame has no type"
    }
  }
}

enum FrameCodec {
  static func control(_ fields: [String: MessagePackValue]) throws -> Data {
    var data = Data([0])
    data.append(try MessagePack.encodeMap(fields))
    return data
  }

  static func ptyInput(sid: Int, data payload: Data) -> Data {
    var data = Data([2])
    appendUInt16(sid, to: &data)
    data.append(payload)
    return data
  }

  static func resize(sid: Int, cols: Int, rows: Int) -> Data {
    var data = Data([3])
    appendUInt16(sid, to: &data)
    appendUInt16(cols, to: &data)
    appendUInt16(rows, to: &data)
    return data
  }

  static func decode(_ data: Data) throws -> IncomingFrame {
    guard let type = data.first else { throw FrameCodecError.emptyFrame }
    switch type {
    case 0:
      let fields = try MessagePack.decodeMap(data.dropFirstData())
      let message = ControlMessage(fields: fields)
      guard !message.type.isEmpty else { throw FrameCodecError.missingControlType }
      return .control(message)
    case 1, 2:
      guard data.count >= 3 else { throw FrameCodecError.shortFrame }
      let sid = readUInt16(data, at: 1)
      let payload = Data(data.dropFirst(3))
      return type == 1 ? .ptyOutput(sid: sid, data: payload) : .ptyInput(sid: sid, data: payload)
    case 3:
      guard data.count >= 7 else { throw FrameCodecError.shortFrame }
      return .resize(
        sid: readUInt16(data, at: 1),
        cols: readUInt16(data, at: 3),
        rows: readUInt16(data, at: 5)
      )
    default:
      throw FrameCodecError.unknownType(type)
    }
  }

  private static func appendUInt16(_ value: Int, to data: inout Data) {
    let clamped = UInt16(clamping: value)
    data.append(UInt8(clamped >> 8))
    data.append(UInt8(clamped & 0xff))
  }

  private static func readUInt16(_ data: Data, at offset: Int) -> Int {
    let bytes = [UInt8](data)
    return Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
  }
}

extension Data {
  fileprivate func dropFirstData() -> Data { Data(dropFirst()) }
}
