import Foundation

/// A JSON value. Requests are decoded into it, responses and events are built from it.
public enum JSON: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    // MARK: Parse / serialize

    public static func parse(_ text: String) throws -> JSON {
        guard let data = text.data(using: .utf8) else { throw JSONError.invalidUTF8 }
        let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return try JSON(any: any)
    }

    init(any: Any) throws {
        switch any {
        case is NSNull: self = .null
        case let n as NSNumber:
            // NSNumber bridges booleans; CFBoolean has a distinct type id.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(try a.map(JSON.init(any:)))
        case let d as [String: Any]: self = .object(try d.mapValues(JSON.init(any:)))
        default: throw JSONError.unsupported(String(describing: type(of: any)))
        }
    }

    /// Compact, key-sorted, one line (no newlines can appear: strings are escaped).
    public func serialized() -> String {
        var out = ""
        write(into: &out)
        return out
    }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n):
            if n.isFinite, n == n.rounded(), abs(n) < 1e15 { out += String(Int64(n)) } else if n.isFinite { out += String(n) } else { out += "null" }
        case .string(let s): JSON.escape(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() { if i > 0 { out += "," }; v.write(into: &out) }
            out += "]"
        case .object(let o):
            out += "{"
            for (i, k) in o.keys.sorted().enumerated() {
                if i > 0 { out += "," }
                JSON.escape(k, into: &out); out += ":"; o[k]!.write(into: &out)
            }
            out += "}"
        }
    }

    private static func escape(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        out += "\""
    }

    // MARK: Accessors

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var objectValue: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    public var arrayValue: [JSON]? { if case .array(let a) = self { return a }; return nil }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
    public var intValue: Int? {
        guard let n = numberValue, n == n.rounded(), abs(n) < 1e15 else { return nil }
        return Int(n)
    }
}

public enum JSONError: Error {
    case invalidUTF8
    case unsupported(String)
}

// Literals make response building readable.
extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSON)...) {
        var o: [String: JSON] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
    public init(nilLiteral: ()) { self = .null }
}

extension JSON {
    public static func str(_ s: String?) -> JSON { s.map(JSON.string) ?? .null }
    public static func int(_ i: Int) -> JSON { .number(Double(i)) }
}
