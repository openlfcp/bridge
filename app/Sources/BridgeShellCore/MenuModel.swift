// The menu's skeleton (U М2, mockups/menubar.md §2): what the status item shows, from what the
// shell knows. The working screens and most actions are E-008 (question cards, Check…, Export
// diagnostics…, Disconnect…, Uninstall…), updates E-056; here they are present and disabled.

import Foundation

/// SMAppService.Status, without ServiceManagement (the app maps it).
public enum LoginItemState: String, Sendable {
  case enabled, requiresApproval, notRegistered, notFound
}

/// What the shell knows about the host and the system.
public struct ShellState: Equatable {
  /// The host's last status; nil while no host runs (starting or restarting).
  public var host: HostState?
  public var hostReason: String?
  public var sections: [SectionStatus] = []
  /// bindingId → needsAttention code.
  public var attention: [String: String] = [:]
  /// bindingId → open question ids.
  public var questions: [String: Set<String>] = [:]
  public var loginItem: LoginItemState = .notRegistered
  /// The host is being restarted after it exited.
  public var reconnecting = false

  public init() {}

  /// Applies one event of the host.
  public mutating func apply(_ event: HostEvent) {
    switch event {
    case .status(let state, let reason, let sections):
      host = state
      hostReason = reason
      self.sections = sections
      reconnecting = false
    case .needsAttention(let b, let code):
      attention[b] = code
    case .question(let q, let b, _, let resolved):
      var open = questions[b] ?? []
      if resolved { open.remove(q) } else { open.insert(q) }
      questions[b] = open.isEmpty ? nil : open
    case .hello, .reply, .unknown:
      break
    }
  }
}

public enum MenuAction: String, Sendable {
  case pause, resume, pasteLink, check, exportDiagnostics, toggleAutoUpdate, toggleStartAtLogin
  case openLoginItems, checkForUpdates, disconnect, uninstall, quit
}

public struct MenuItem: Equatable {
  public var title: String
  public var action: MenuAction?
  public var enabled: Bool
  public var checked: Bool
  public var children: [MenuItem]
  public var isSeparator: Bool

  public init(
    _ title: String, action: MenuAction? = nil, enabled: Bool = true, checked: Bool = false,
    children: [MenuItem] = []
  ) {
    self.title = title
    self.action = action
    self.enabled = enabled
    self.checked = checked
    self.children = children
    self.isSeparator = false
  }

  public static let separator: MenuItem = {
    var s = MenuItem("")
    s.isSeparator = true
    s.enabled = false
    return s
  }()
}

/// The status item's icon: ◉ normal · ◉• needs attention · ⊘ stopped (U М2).
public enum IconState: String, Sendable {
  case normal, attention, stopped
}

public enum MenuModel {
  /// Actions that work in this build; the rest are shown disabled until their task.
  public static let working: Set<MenuAction> = [
    .pause, .resume, .toggleStartAtLogin, .openLoginItems, .quit,
  ]

  public static func headline(_ s: ShellState) -> String {
    if s.reconnecting { return "Reconnecting…" }
    switch s.host {
    case nil, .starting?: return "Starting…"
    case .running?: return needsSomething(s) ? "Needs attention" : "Up to date"
    case .paused?: return "Paused"
    case .unavailable?: return "Not running"
    case .stopping?: return "Stopping…"
    }
  }

  public static func icon(_ s: ShellState) -> IconState {
    if s.host == .paused { return .stopped }
    if s.host == .unavailable || needsSomething(s) || s.loginItem == .requiresApproval {
      return .attention
    }
    return .normal
  }

  public static func sectionLine(_ section: SectionStatus, _ s: ShellState) -> String {
    let what: String
    if s.attention[section.bindingId] != nil {
      what = "Needs attention"
    } else if s.questions[section.bindingId] != nil {
      what = "Needs your answer"
    } else {
      switch section.state {
      case "active": what = "Up to date"
      case "bootstrapping", "pending_dry_run": what = "Setting up"
      default: what = section.state
      }
    }
    return "\(section.title) · \(what)"
  }

  public static func items(_ s: ShellState, autoUpdate: Bool = true) -> [MenuItem] {
    func item(_ title: String, _ action: MenuAction, checked: Bool = false) -> MenuItem {
      MenuItem(title, action: action, enabled: working.contains(action), checked: checked)
    }
    var out: [MenuItem] = [MenuItem("LFCP Bridge · \(headline(s))", enabled: false), .separator]
    if !s.sections.isEmpty {
      out += s.sections.map { MenuItem(sectionLine($0, s), enabled: false) }
      out.append(.separator)
    }
    if s.loginItem == .requiresApproval {
      out.append(item("Allow LFCP Bridge to start at login…", .openLoginItems))
    }
    var pause = s.host == .paused ? item("Resume syncing", .resume) : item("Pause syncing", .pause)
    pause.enabled = s.host == .running || s.host == .paused
    out += [
      pause,
      item("Paste connection link…", .pasteLink),
      item("Check…", .check),
      item("Export diagnostics…", .exportDiagnostics),
      MenuItem(
        "Settings",
        children: [
          item("Install updates automatically", .toggleAutoUpdate, checked: autoUpdate),
          item(
            "Start at login", .toggleStartAtLogin,
            checked: s.loginItem == .enabled || s.loginItem == .requiresApproval),
        ]),
      item("Check for Updates…", .checkForUpdates),
      item("Disconnect from Obsidian…", .disconnect),
      item("Uninstall…", .uninstall),
      item("Quit LFCP Bridge", .quit),
    ]
    return out
  }

  private static func needsSomething(_ s: ShellState) -> Bool {
    !s.attention.isEmpty || !s.questions.isEmpty
  }
}
