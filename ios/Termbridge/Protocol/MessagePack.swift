import Foundation

enum MessagePackValue: Equatable {
  case null
  case bool(Bool)
  case int(Int64)
  case uint(UInt64)
  case double(Double)
  case string(String)
  case binary(Data)
  case array([MessagePackValue])
  case map([String: MessagePackValue])

  var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var boolValue: Bool? {
    guard case .bool(let value) = self else { return nil }
    return value
  }

  var intValue: Int? {
    switch self {
    case .int(let value): return Int(exactly: value)
    case .uint(let value): return Int(exactly: value)
    case .double(let value): return Int(exactly: value)
    default: return nil
    }
  }

  var doubleValue: Double? {
    switch self {
    case .int(let value): return Double(value)
    case .uint(let value): return Double(value)
    case .double(let value): return value
    default: return nil
    }
  }

  var arrayValue: [MessagePackValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  var mapValue: [String: MessagePackValue]? {
    guard case .map(let value) = self else { return nil }
    return value
  }
}

enum MessagePackError: Error, LocalizedError {
  case unexpectedEnd
  case invalidUTF8
  case invalidMapKey
  case unsupportedType(UInt8)
  case lengthOverflow
  case trailingBytes

  var errorDescription: String? {
    switch self {
    case .unexpectedEnd: return "MessagePack ended unexpectedly"
    case .invalidUTF8: return "MessagePack string is not UTF-8"
    case .invalidMapKey: return "MessagePack map key is not a string"
    case .unsupportedType(let type):
      return String(format: "Unsupported MessagePack type 0x%02x", type)
    case .lengthOverflow: return "MessagePack value is too large"
    case .trailingBytes: return "MessagePack contains trailing bytes"
    }
  }
}

enum MessagePack {
  static func encodeMap(_ map: [String: MessagePackValue]) throws -> Data {
    var encoder = Encoder()
    try encoder.write(.map(map))
    return encoder.data
  }

  static func decodeMap(_ data: Data) throws -> [String: MessagePackValue] {
    var decoder = Decoder(data: data)
    let value = try decoder.readValue()
    guard decoder.isAtEnd else { throw MessagePackError.trailingBytes }
    guard case .map(let map) = value else { throw MessagePackError.invalidMapKey }
    return map
  }

  private struct Encoder {
    var data = Data()

    mutating func write(_ value: MessagePackValue) throws {
      switch value {
      case .null:
        append(0xc0)
      case .bool(let value):
        append(value ? 0xc3 : 0xc2)
      case .int(let value):
        writeSigned(value)
      case .uint(let value):
        writeUnsigned(value)
      case .double(let value):
        append(0xcb)
        appendBE(value.bitPattern)
      case .string(let value):
        let bytes = Data(value.utf8)
        try writeStringHeader(bytes.count)
        data.append(bytes)
      case .binary(let value):
        try writeBinaryHeader(value.count)
        data.append(value)
      case .array(let values):
        try writeArrayHeader(values.count)
        for child in values { try write(child) }
      case .map(let values):
        try writeMapHeader(values.count)
        for (key, child) in values {
          try write(.string(key))
          try write(child)
        }
      }
    }

    private mutating func writeSigned(_ value: Int64) {
      if value >= 0 {
        writeUnsigned(UInt64(value))
      } else if value >= -32 {
        append(UInt8(bitPattern: Int8(value)))
      } else if value >= Int64(Int8.min) {
        append(0xd0)
        append(UInt8(bitPattern: Int8(value)))
      } else if value >= Int64(Int16.min) {
        append(0xd1)
        appendBE(UInt16(bitPattern: Int16(value)))
      } else if value >= Int64(Int32.min) {
        append(0xd2)
        appendBE(UInt32(bitPattern: Int32(value)))
      } else {
        append(0xd3)
        appendBE(UInt64(bitPattern: value))
      }
    }

    private mutating func writeUnsigned(_ value: UInt64) {
      if value <= 0x7f {
        append(UInt8(value))
      } else if value <= UInt64(UInt8.max) {
        append(0xcc)
        append(UInt8(value))
      } else if value <= UInt64(UInt16.max) {
        append(0xcd)
        appendBE(UInt16(value))
      } else if value <= UInt64(UInt32.max) {
        append(0xce)
        appendBE(UInt32(value))
      } else {
        append(0xcf)
        appendBE(value)
      }
    }

    private mutating func writeStringHeader(_ count: Int) throws {
      if count <= 31 {
        append(0xa0 | UInt8(count))
      } else if count <= Int(UInt8.max) {
        append(0xd9)
        append(UInt8(count))
      } else if count <= Int(UInt16.max) {
        append(0xda)
        appendBE(UInt16(count))
      } else if count <= Int(UInt32.max) {
        append(0xdb)
        appendBE(UInt32(count))
      } else {
        throw MessagePackError.lengthOverflow
      }
    }

    private mutating func writeBinaryHeader(_ count: Int) throws {
      if count <= Int(UInt8.max) {
        append(0xc4)
        append(UInt8(count))
      } else if count <= Int(UInt16.max) {
        append(0xc5)
        appendBE(UInt16(count))
      } else if count <= Int(UInt32.max) {
        append(0xc6)
        appendBE(UInt32(count))
      } else {
        throw MessagePackError.lengthOverflow
      }
    }

    private mutating func writeArrayHeader(_ count: Int) throws {
      if count <= 15 {
        append(0x90 | UInt8(count))
      } else if count <= Int(UInt16.max) {
        append(0xdc)
        appendBE(UInt16(count))
      } else if count <= Int(UInt32.max) {
        append(0xdd)
        appendBE(UInt32(count))
      } else {
        throw MessagePackError.lengthOverflow
      }
    }

    private mutating func writeMapHeader(_ count: Int) throws {
      if count <= 15 {
        append(0x80 | UInt8(count))
      } else if count <= Int(UInt16.max) {
        append(0xde)
        appendBE(UInt16(count))
      } else if count <= Int(UInt32.max) {
        append(0xdf)
        appendBE(UInt32(count))
      } else {
        throw MessagePackError.lengthOverflow
      }
    }

    private mutating func append(_ byte: UInt8) { data.append(byte) }
    private mutating func appendBE<T: FixedWidthInteger>(_ value: T) {
      var bigEndian = value.bigEndian
      withUnsafeBytes(of: &bigEndian) { data.append(contentsOf: $0) }
    }
  }

  private struct Decoder {
    let bytes: [UInt8]
    var offset = 0

    init(data: Data) { bytes = Array(data) }
    var isAtEnd: Bool { offset == bytes.count }

    mutating func readValue() throws -> MessagePackValue {
      let prefix = try readByte()
      switch prefix {
      case 0x00...0x7f: return .uint(UInt64(prefix))
      case 0x80...0x8f: return try readMap(Int(prefix & 0x0f))
      case 0x90...0x9f: return try readArray(Int(prefix & 0x0f))
      case 0xa0...0xbf: return try readString(Int(prefix & 0x1f))
      case 0xc0: return .null
      case 0xc2: return .bool(false)
      case 0xc3: return .bool(true)
      case 0xc4: return .binary(Data(try readBytes(Int(try readByte()))))
      case 0xc5: return .binary(Data(try readBytes(Int(try readUInt16()))))
      case 0xc6: return .binary(Data(try readBytes(try checkedLength(readUInt32()))))
      case 0xca: return .double(Double(Float(bitPattern: try readUInt32())))
      case 0xcb: return .double(Double(bitPattern: try readUInt64()))
      case 0xcc: return .uint(UInt64(try readByte()))
      case 0xcd: return .uint(UInt64(try readUInt16()))
      case 0xce: return .uint(UInt64(try readUInt32()))
      case 0xcf: return .uint(try readUInt64())
      case 0xd0: return .int(Int64(Int8(bitPattern: try readByte())))
      case 0xd1: return .int(Int64(Int16(bitPattern: try readUInt16())))
      case 0xd2: return .int(Int64(Int32(bitPattern: try readUInt32())))
      case 0xd3: return .int(Int64(bitPattern: try readUInt64()))
      case 0xd4: return try readFixExtension1(prefix: prefix)
      case 0xd9: return try readString(Int(try readByte()))
      case 0xda: return try readString(Int(try readUInt16()))
      case 0xdb: return try readString(try checkedLength(readUInt32()))
      case 0xdc: return try readArray(Int(try readUInt16()))
      case 0xdd: return try readArray(try checkedLength(readUInt32()))
      case 0xde: return try readMap(Int(try readUInt16()))
      case 0xdf: return try readMap(try checkedLength(readUInt32()))
      case 0xe0...0xff: return .int(Int64(Int8(bitPattern: prefix)))
      default: throw MessagePackError.unsupportedType(prefix)
      }
    }

    private mutating func readFixExtension1(prefix: UInt8) throws -> MessagePackValue {
      let extensionType = try readByte()
      let payload = try readByte()
      // msgpackr encodes JavaScript `undefined` as fixext1(type: 0, data: 0).
      // It is equivalent to a missing/nullable field in Termbridge controls.
      guard extensionType == 0, payload == 0 else {
        throw MessagePackError.unsupportedType(prefix)
      }
      return .null
    }

    private mutating func readString(_ count: Int) throws -> MessagePackValue {
      guard let value = String(data: Data(try readBytes(count)), encoding: .utf8) else {
        throw MessagePackError.invalidUTF8
      }
      return .string(value)
    }

    private mutating func readArray(_ count: Int) throws -> MessagePackValue {
      var values: [MessagePackValue] = []
      values.reserveCapacity(count)
      for _ in 0..<count { values.append(try readValue()) }
      return .array(values)
    }

    private mutating func readMap(_ count: Int) throws -> MessagePackValue {
      var values: [String: MessagePackValue] = [:]
      values.reserveCapacity(count)
      for _ in 0..<count {
        guard case .string(let key) = try readValue() else { throw MessagePackError.invalidMapKey }
        values[key] = try readValue()
      }
      return .map(values)
    }

    private mutating func readByte() throws -> UInt8 {
      guard offset < bytes.count else { throw MessagePackError.unexpectedEnd }
      defer { offset += 1 }
      return bytes[offset]
    }

    private mutating func readBytes(_ count: Int) throws -> [UInt8] {
      guard count >= 0, offset <= bytes.count - count else { throw MessagePackError.unexpectedEnd }
      defer { offset += count }
      return Array(bytes[offset..<(offset + count)])
    }

    private mutating func readUInt16() throws -> UInt16 {
      let value = try readBytes(2)
      return UInt16(value[0]) << 8 | UInt16(value[1])
    }

    private mutating func readUInt32() throws -> UInt32 {
      let value = try readBytes(4)
      return value.reduce(0) { ($0 << 8) | UInt32($1) }
    }

    private mutating func readUInt64() throws -> UInt64 {
      let value = try readBytes(8)
      return value.reduce(0) { ($0 << 8) | UInt64($1) }
    }

    private func checkedLength(_ value: UInt32) throws -> Int {
      guard let result = Int(exactly: value) else { throw MessagePackError.lengthOverflow }
      return result
    }
  }
}
