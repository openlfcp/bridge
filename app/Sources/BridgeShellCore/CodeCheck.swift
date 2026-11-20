// The code checks of the write gate (A§9.1 (3)–(5), E-051b), made by the shell with
// Security.framework and sent to the host as codeIdentity (IPC.swift):
//   (3) SecStaticCodeCheckValidity of the bundle, strict, nested code included;
//   (4) the cdhash (kSecCodeInfoUnique) of the running shell: SecCodeCopySelf, checked against
//       what the kernel runs (SecCodeCheckValidity: on-disk code that is not the running one fails);
//   (5) the cdhash of every Mach-O the host names, for this slice (SecStaticCodeCreateWithPath-
//       AndAttributes + kSecCodeAttributeArchitecture). A file that has no signature for the slice is
//       left out: the gate sees it missing, a mismatch.
// The host compares them with the artifact manifest (packages/host/src/artifact/gate.ts).

import Foundation
import Security

public struct CodeIdentity: Equatable, Sendable {
  public struct Nested: Equatable, Sendable {
    public let path: String
    public let cdhash: String
    public init(path: String, cdhash: String) {
      self.path = path
      self.cdhash = cdhash
    }
  }
  public let arch: String
  public let valid: Bool
  /// Why the signature check failed (an OSStatus and its text); nil when valid.
  public let detail: String?
  public let shell: String
  public let nested: [Nested]

  public init(arch: String, valid: Bool, detail: String?, shell: String, nested: [Nested]) {
    self.arch = arch
    self.valid = valid
    self.detail = detail
    self.shell = shell
    self.nested = nested
  }
}

public enum CodeReport: Equatable, Sendable {
  case identity(CodeIdentity)
  /// The running shell's own identity could not be read: the gate keeps preview.
  case failed(String)
}

public enum CodeCheck {
  /// The slice this shell runs as.
  public static var arch: String {
    #if arch(arm64)
      return "arm64"
    #else
      return "x86_64"
    #endif
  }

  /// All three checks, for the bundle at `bundle` and the bundle-relative Mach-O `paths`.
  public static func run(bundle: URL, paths: [String]) -> CodeReport {
    let shell: String
    do {
      shell = try runningCdhash()
    } catch {
      return .failed("the running shell: \(error)")
    }
    let validity = checkValidity(bundle)
    var nested: [CodeIdentity.Nested] = []
    for path in paths where !path.split(separator: "/").contains("..") {
      if let h = try? cdhash(file: bundle.appendingPathComponent(path), arch: arch) {
        nested.append(.init(path: path, cdhash: h))
      }
    }
    return .identity(
      CodeIdentity(arch: arch, valid: validity == nil, detail: validity, shell: shell, nested: nested))
  }

  /// (3): nil when the bundle's signature holds, else why not.
  public static func checkValidity(_ bundle: URL) -> String? {
    var code: SecStaticCode?
    var status = SecStaticCodeCreateWithPath(bundle as CFURL, SecCSFlags(), &code)
    guard status == errSecSuccess, let code else { return describe(status) }
    var error: Unmanaged<CFError>?
    let flags = SecCSFlags(rawValue: UInt32(kSecCSStrictValidate) | UInt32(kSecCSCheckNestedCode))
    status = SecStaticCodeCheckValidityWithErrors(code, flags, nil, &error)
    if status == errSecSuccess { return nil }
    let text = error.map { CFErrorCopyDescription($0.takeRetainedValue()) as String }
    return text ?? describe(status)
  }

  /// (4): the cdhash of the code this process runs. Its resources are (3)'s: a changed byte in
  /// Resources/ must come back as an identity whose signature fails (code-invalid), not as an
  /// unknown identity — so the running code is checked against its executable only.
  public static func runningCdhash() throws -> String {
    var me: SecCode?
    var status = SecCodeCopySelf(SecCSFlags(), &me)
    guard status == errSecSuccess, let me else { throw CodeCheckError(status) }
    status = SecCodeCheckValidity(me, SecCSFlags(rawValue: kSecCSDoNotValidateResources), nil)
    guard status == errSecSuccess else { throw CodeCheckError(status) }
    var staticCode: SecStaticCode?
    status = SecCodeCopyStaticCode(me, SecCSFlags(), &staticCode)
    guard status == errSecSuccess, let staticCode else { throw CodeCheckError(status) }
    return try unique(staticCode)
  }

  /// (5): the cdhash of one Mach-O for one slice.
  public static func cdhash(file: URL, arch: String) throws -> String {
    var code: SecStaticCode?
    let attributes = [kSecCodeAttributeArchitecture as String: arch] as CFDictionary
    let status = SecStaticCodeCreateWithPathAndAttributes(file as CFURL, SecCSFlags(), attributes, &code)
    guard status == errSecSuccess, let code else { throw CodeCheckError(status) }
    return try unique(code)
  }

  private static func unique(_ code: SecStaticCode) throws -> String {
    var info: CFDictionary?
    let status = SecCodeCopySigningInformation(
      code, SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)), &info)
    guard status == errSecSuccess, let dict = info as? [String: Any],
      let data = dict[kSecCodeInfoUnique as String] as? Data
    else { throw CodeCheckError(status == errSecSuccess ? errSecCSUnsigned : status) }
    return data.map { String(format: "%02x", $0) }.joined()
  }

  static func describe(_ status: OSStatus) -> String {
    let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
    return "OSStatus \(status): \(text)"
  }
}

public struct CodeCheckError: Error, CustomStringConvertible {
  public let status: OSStatus
  init(_ status: OSStatus) { self.status = status }
  public var description: String { CodeCheck.describe(status) }
}
