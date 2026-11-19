// The shell's main process (A§1, A§2.3): the status item and its menu, the host under the
// supervisor, SMAppService.agent, lfcp-bridge:// and the shutdown reasons (quit, logout; update
// comes with Sparkle, E-056).

import AppKit
import BridgeShellCore
import ServiceManagement

let agentPlist = "org.openlfcp.bridge.agent.plist"

/// ~/Library/Logs/org.openlfcp.bridge (LFCP_BRIDGE_LOGS overrides, as for the host).
func logsDirectory() -> URL {
  if let dir = ProcessInfo.processInfo.environment["LFCP_BRIDGE_LOGS"] {
    return URL(fileURLWithPath: dir, isDirectory: true)
  }
  return FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/org.openlfcp.bridge", isDirectory: true)
}

final class FileLog: ShellLog {
  private let url: URL
  private let formatter = ISO8601DateFormatter()

  init(_ url: URL) {
    self.url = url
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  }

  func info(_ message: String) {
    let data = Data("\(formatter.string(from: Date())) \(message)\n".utf8)
    if let h = try? FileHandle(forWritingTo: url) {
      _ = try? h.seekToEnd()
      try? h.write(contentsOf: data)
      try? h.close()
    } else {
      FileManager.default.createFile(
        atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  let logs = logsDirectory()
  lazy var log = FileLog(logs.appendingPathComponent("shell.log"))
  var supervisor: HostSupervisor!
  var handoff: URLHandoff!
  var statusItem: NSStatusItem?
  var state = ShellState()
  var helloVersion: String?
  var replies = (ok: 0, failed: 0)
  /// Why the app is quitting: the host's shutdown reason.
  var terminateReason: ShutdownReason = .quit
  /// Set when the host has ended at termination (the L5 smoke reads it).
  var hostExit: Int32??
  let loginItem = SMAppService.agent(plistName: agentPlist)

  func applicationWillFinishLaunching(_ notification: Notification) {
    let launcher = ProcessHostLauncher(
      .bundled(
        bundle: Bundle.main.bundleURL, inherited: ProcessInfo.processInfo.environment,
        stderrPath: logs.appendingPathComponent("host.log").path))
    supervisor = HostSupervisor(launcher: launcher, scheduler: MainQueueScheduler(), log: log)
    // URLs can come before didFinishLaunching: they wait in the handoff until the host runs.
    handoff = URLHandoff(send: { [weak self] in self?.supervisor.send($0) }, log: log)
    supervisor.onEvent = { [weak self] in self?.hostEvent($0) }
    supervisor.onPhase = { [weak self] in self?.hostPhase($0) }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let other = olderInstance() {
      // Opened while running (Finder, or SMAppService's RunAtLoad after register): one is enough.
      // Exit 0, so that the agent's KeepAlive {SuccessfulExit:false} does not start us again.
      log.info("shell: already running (pid \(other)); exiting")
      exit(0)
    }
    log.info("shell: started \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?")")
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    menu.autoenablesItems = false
    menu.delegate = self
    item.menu = menu
    statusItem = item
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(willPowerOff(_:)), name: NSWorkspace.willPowerOffNotification,
      object: nil)
    setUpLoginItem()
    refresh()
    supervisor.start()
    #if LFCP_TEST_HOOKS
      TestHooks.start(self)
    #endif
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    handoff.open(urls)
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let supervisor, supervisor.phase != .stopped else { return .terminateNow }
    let reason = terminateReason
    supervisor.shutdown(reason) { [weak self] status in
      guard let self else { return }
      self.hostExit = .some(status)
      self.log.info("shell: host ended (\(status.map(String.init) ?? "none")); quitting (\(reason.rawValue))")
      #if LFCP_TEST_HOOKS
        TestHooks.report(self)
      #endif
      DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  @objc func willPowerOff(_ notification: Notification) {
    terminateReason = .logout
  }

  // MARK: host

  func hostEvent(_ event: HostEvent) {
    switch event {
    case .hello(let version, _):
      helloVersion = version
    case .reply(let id, let ok, let code):
      if ok {
        replies.ok += 1
      } else {
        replies.failed += 1
        log.info("host: command \(id ?? "?") refused: \(code ?? "?")")
      }
    default: break
    }
    state.apply(event)
    handoff.hostEvent(event)
    refresh()
  }

  func hostPhase(_ phase: HostSupervisor.Phase) {
    handoff.hostPhase(phase)
    if case .backingOff = phase {
      state.host = nil
      state.reconnecting = true
    }
    refresh()
  }

  // MARK: login item (A§2.3, U М1.6)

  func setUpLoginItem() {
    let wanted = UserDefaults.standard.object(forKey: "startAtLogin") as? Bool ?? true
    // Not registered yet reads as .notFound on macOS 15 (not only .notRegistered): register both.
    let before = loginItem.status
    if wanted && before != .enabled && before != .requiresApproval {
      do {
        try loginItem.register()
        log.info("login item: registered")
      } catch {
        log.info("login item: register failed: \(error.localizedDescription)")
      }
    }
    state.loginItem = loginItemState()
  }

  func loginItemState() -> LoginItemState {
    switch loginItem.status {
    case .enabled: return .enabled
    case .requiresApproval: return .requiresApproval
    case .notFound: return .notFound
    case .notRegistered: return .notRegistered
    @unknown default: return .notFound
    }
  }

  func toggleStartAtLogin() {
    let on = state.loginItem == .enabled || state.loginItem == .requiresApproval
    UserDefaults.standard.set(!on, forKey: "startAtLogin")
    do {
      if on { try loginItem.unregister() } else { try loginItem.register() }
      log.info("login item: \(on ? "unregistered" : "registered")")
    } catch {
      log.info("login item: change failed: \(error.localizedDescription)")
    }
    state.loginItem = loginItemState()
    refresh()
  }

  // MARK: menu

  func refresh() {
    guard let button = statusItem?.button else { return }
    let symbol: String
    switch MenuModel.icon(state) {
    case .normal: symbol = "circle.circle"
    case .attention: symbol = "circle.circle.fill"
    case .stopped: symbol = "circle.slash"
    }
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "LFCP Bridge")
    button.image?.isTemplate = true
    button.toolTip = "LFCP Bridge · \(MenuModel.headline(state))"
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    state.loginItem = loginItemState()
    menu.removeAllItems()
    for item in MenuModel.items(state) { menu.addItem(nsItem(item)) }
  }

  private func nsItem(_ m: MenuItem) -> NSMenuItem {
    if m.isSeparator { return .separator() }
    let item = NSMenuItem(title: m.title, action: nil, keyEquivalent: "")
    if let action = m.action, m.enabled {
      item.action = #selector(menuAction(_:))
      item.target = self
      item.representedObject = action.rawValue
    }
    item.isEnabled = m.enabled && m.action != nil
    item.state = m.checked ? .on : .off
    if !m.children.isEmpty {
      let sub = NSMenu()
      sub.autoenablesItems = false
      m.children.forEach { sub.addItem(nsItem($0)) }
      item.submenu = sub
      item.isEnabled = true
    }
    return item
  }

  @objc func menuAction(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let action = MenuAction(rawValue: raw)
    else { return }
    perform(action)
  }

  func perform(_ action: MenuAction) {
    switch action {
    case .pause: supervisor.send(.pause)
    case .resume: supervisor.send(.resume)
    case .toggleStartAtLogin: toggleStartAtLogin()
    case .openLoginItems: SMAppService.openSystemSettingsLoginItems()
    case .quit:
      terminateReason = .quit
      NSApp.terminate(nil)
    default:
      log.info("menu: \(action.rawValue) is not available in this build")
    }
  }

  /// Another copy of this app that was launched before us, if any.
  private func olderInstance() -> pid_t? {
    guard let id = Bundle.main.bundleIdentifier else { return nil }
    let me = NSRunningApplication.current
    let mine = me.launchDate ?? Date()
    return NSRunningApplication.runningApplications(withBundleIdentifier: id).first { other in
      guard other.processIdentifier != me.processIdentifier, !other.isTerminated else { return false }
      let theirs = other.launchDate ?? .distantFuture
      return theirs < mine || (theirs == mine && other.processIdentifier < me.processIdentifier)
    }?.processIdentifier
  }
}
