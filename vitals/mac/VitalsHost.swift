// VITALS - a system monitor that measures the machine it runs on and explains what it finds.
// Copyright 2026 Ben M
// SPDX-License-Identifier: Apache-2.0
//
// VITALS - THE macOS PANEL HOST.
//
// The Windows panel is a WinForms window with FormBorderStyle=None hosting WebView2. That exists
// because a browser cannot be made frameless from the outside: Chromium paints its own title bar
// INSIDE the client area, so stripping the window style knocks it onto the native frame, which
// looks worse. The same is true here, so macOS needs the same answer in its own idiom: host the
// page yourself.
//
// This is that host. WKWebView in a borderless NSWindow - Apple's own browser engine, no bundled
// runtime, ~250 lines, no dependencies beyond the system frameworks.
//
// BUILD (no Xcode project, no signing needed to run locally):
//     swiftc -O -o VITALS VitalsHost.swift -framework Cocoa -framework WebKit
//     ./VITALS --port 8790
//
// WHY NOT JUST A BROWSER IN APP MODE. That is what ships today and it is declared 'partial' in the
// capability manifest for a reason: no frameless surface, no edge docking, no always-on-top, and a
// dock icon for a window that wants to behave like an instrument. Everything below is what the
// Windows host does, done the way AppKit wants it done.
//
// WHAT IS DELIBERATELY NOT HERE. Code signing and notarisation. An unsigned binary runs fine when
// built locally, which is what a developer does; shipping one to strangers needs an Apple Developer
// certificate, which is a purchase and not a line of code. Stated rather than pretended.

import Cocoa
import WebKit

// ---------------------------------------------------------------------------- arguments

struct Options {
    var port = 8790
    var path = "/"
    var title = "VITALS"
    var width: CGFloat = 1240
    var height: CGFloat = 820
    var alpha: CGFloat = 0.94      // the panel is glass; setup passes 1 (see setup.js)
    var onTop = true

    static func parse(_ argv: [String]) -> Options {
        var o = Options()
        var i = 0
        while i < argv.count {
            let a = argv[i]
            func next() -> String? { i + 1 < argv.count ? argv[i + 1] : nil }
            switch a {
            case "--port":   if let v = next(), let n = Int(v) { o.port = n }; i += 1
            case "--path":   if let v = next() { o.path = v }; i += 1
            case "--title":  if let v = next() { o.title = v }; i += 1
            case "--width":  if let v = next(), let n = Double(v) { o.width = CGFloat(n) }; i += 1
            case "--height": if let v = next(), let n = Double(v) { o.height = CGFloat(n) }; i += 1
            case "--alpha":  if let v = next(), let n = Double(v) { o.alpha = CGFloat(n) }; i += 1
            case "--no-top": o.onTop = false
            default: break
            }
            i += 1
        }
        return o
    }
}

// ---------------------------------------------------------------------------- the window

/// Borderless windows are not key or main by default, so text fields inside the page would never
/// receive keystrokes. Both must be overridden or the Ask box silently ignores typing - the exact
/// class of "the button does nothing" bug the Windows host had to fix twice.
final class PanelWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// ---------------------------------------------------------------------------- app

final class Host: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSMenuDelegate {
    let opts: Options
    var window: PanelWindow!
    var web: WKWebView!
    /// The menu-bar item. On Windows this is the tray icon (host.tray); on macOS the menu bar is
    /// the same idea in the platform's own idiom. It matters more here than there: the accessory
    /// activation policy below removes the Dock icon and the app switcher entry, so without this
    /// item a hidden panel would have NO visible handle at all - invisible-but-running is how a
    /// monitor gets force-quit by someone who thinks it is stuck.
    var statusItem: NSStatusItem?
    /// Set while a drag is in progress so the mouse-moved handler knows to move the window.
    var dragOrigin: NSPoint?

    init(_ o: Options) { opts = o }

    var url: URL { URL(string: "http://127.0.0.1:\(opts.port)\(opts.path)")! }

    func applicationDidFinishLaunching(_: Notification) {
        let cfg = WKWebViewConfiguration()

        // The page asks the host to do window things by posting messages, exactly as the Windows
        // host receives them through WebMessageReceived. One channel, named the same, so the
        // dashboard's existing send() calls work here without a macOS branch in the page.
        let ucc = WKUserContentController()
        ucc.add(self, name: "vitals")
        cfg.userContentController = ucc

        // Give the page a marker so it can tell a real host from a browser tab - the same reason
        // the Windows build sets one. A page that cannot tell will offer window controls that do
        // nothing when opened in Safari.
        let mark = WKUserScript(
            source: "window.__vitalsHost = 'macos';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        ucc.addUserScript(mark)

        window = PanelWindow(
            contentRect: NSRect(x: 0, y: 0, width: opts.width, height: opts.height),
            styleMask: [.borderless, .resizable, .miniaturizable],
            backing: .buffered, defer: false)

        window.title = opts.title
        window.isOpaque = false
        window.backgroundColor = .clear          // the PAGE draws the shell, including its corners
        window.alphaValue = max(0.25, min(1.0, opts.alpha))
        window.hasShadow = true
        window.isMovableByWindowBackground = false   // we run our own drag; see below
        window.level = opts.onTop ? .floating : .normal
        window.collectionBehavior = [.fullScreenAuxiliary, .managed]
        window.center()

        web = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        // Transparent, so the page's own translucent shell is what the user sees rather than a
        // white rectangle behind it. The Windows host sets DefaultBackgroundColor for this reason;
        // on AppKit the equivalent is refusing to draw a background at all.
        web.setValue(false, forKey: "drawsBackground")
        window.contentView!.addSubview(web)

        web.load(URLRequest(url: url))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // An instrument is not a document. Accessory policy keeps it out of the Dock and the
        // app switcher, which is what "panel" means on this platform.
        NSApp.setActivationPolicy(.accessory)

        installStatusItem()
    }

    // ------------------------------------------------------------------ menu bar (host.tray)

    func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
            // A template symbol so the glyph follows the menu bar's light/dark rendering. The
            // text fallback exists because a status item with neither image nor title is an
            // invisible click target occupying real menu-bar space.
            if let img = NSImage(systemSymbolName: "waveform.path.ecg", accessibilityDescription: "VITALS") {
                img.isTemplate = true
                btn.image = img
            } else {
                btn.title = "VITALS"
            }
            btn.toolTip = "VITALS - this machine, measured"
        }
        let menu = NSMenu()
        // Autoenablement would re-derive isEnabled from the responder chain and quietly override
        // what menuNeedsUpdate sets; enablement here is decided from window state, by us.
        menu.autoenablesItems = false
        menu.addItem(NSMenuItem(title: "Show panel", action: #selector(showPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Hide panel", action: #selector(hidePanel), keyEquivalent: ""))
        let top = NSMenuItem(title: "Float on top", action: #selector(toggleTop), keyEquivalent: "")
        menu.addItem(top)
        menu.addItem(.separator())
        // Named precisely: quitting the PANEL leaves the bridge measuring, and saying just "Quit"
        // would let someone believe they had stopped the recorder.
        menu.addItem(NSMenuItem(title: "Quit panel (bridge keeps measuring)", action: #selector(quitPanel), keyEquivalent: "q"))
        for it in menu.items { it.target = self }
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    @objc func showPanel() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func hidePanel() { window.orderOut(nil) }
    @objc func toggleTop() { window.level = window.level == .floating ? .normal : .floating }
    @objc func quitPanel() { NSApp.terminate(nil) }

    /// The checkmark reflects the WINDOW's actual state at the moment the menu opens - not a
    /// separately-tracked boolean that can drift from it, and drift is the whole failure mode of
    /// mirrored state. Show/Hide enable from the same live fact.
    func menuNeedsUpdate(_ menu: NSMenu) {
        for it in menu.items {
            switch it.action {
            case #selector(toggleTop): it.state = window.level == .floating ? .on : .off
            case #selector(showPanel): it.isEnabled = !window.isVisible
            case #selector(hidePanel): it.isEnabled = window.isVisible
            default: break
            }
        }
    }

    // ------------------------------------------------------------------ page -> host messages

    func userContentController(_: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? String else { return }

        switch body {
        case "drag":
            // The page decided this mousedown was on draggable chrome rather than a control - the
            // same NO_DRAG selector test the Windows build uses. Handing the decision to the page
            // keeps one definition of "what is draggable" instead of two that drift.
            if let ev = NSApp.currentEvent { window.performDrag(with: ev) }

        case "close":
            // Closing the panel must not stop the bridge. The record keeps being written whether a
            // window is open or not - that is the whole premise of asking "why was it slow
            // yesterday" - so this hides the window and leaves the collector running.
            NSApp.terminate(nil)

        case "minimize":
            window.miniaturize(nil)

        case "top:on":  window.level = .floating
        case "top:off": window.level = .normal

        default:
            if body.hasPrefix("alpha:"),
               let n = Double(body.dropFirst("alpha:".count)) {
                // The page sends 0-255 to match the Windows host's parameter; normalise here so the
                // page does not need to know which host it is talking to.
                window.alphaValue = max(0.25, min(1.0, CGFloat(n) / 255.0))
            } else if body.hasPrefix("size:") {
                let parts = body.dropFirst("size:".count).split(separator: ",").compactMap { Double($0) }
                if parts.count == 2 {
                    var f = window.frame
                    f.size = NSSize(width: parts[0], height: parts[1])
                    window.setFrame(f, display: true, animate: false)
                }
            } else if body.hasPrefix("dock:") {
                dock(String(body.dropFirst("dock:".count)))
            }
        }
    }

    /// Edge docking. The Windows host rolls its own drag loop so it can dock DURING the drag rather
    /// than on mouse-up; AppKit's performDrag is modal in the same way, so the page asks for a dock
    /// explicitly once it has decided the cursor crossed a threshold. Same outcome, less Win32.
    func dock(_ edge: String) {
        guard let screen = window.screen ?? NSScreen.main else { return }
        let v = screen.visibleFrame
        let strip: CGFloat = 138          // matches the Windows docked sidebar width
        switch edge {
        case "left":
            window.setFrame(NSRect(x: v.minX, y: v.minY, width: strip, height: v.height),
                            display: true, animate: true)
        case "right":
            window.setFrame(NSRect(x: v.maxX - strip, y: v.minY, width: strip, height: v.height),
                            display: true, animate: true)
        case "top":
            window.setFrame(NSRect(x: v.minX, y: v.maxY - 46, width: v.width, height: 46),
                            display: true, animate: true)
        default:      // "float" - back to the panel size
            window.setFrame(NSRect(x: v.midX - opts.width / 2, y: v.midY - opts.height / 2,
                                   width: opts.width, height: opts.height),
                            display: true, animate: true)
        }
    }

    // ------------------------------------------------------------------ load failures

    /// A blank window is the worst possible failure for a monitor: it looks like the app is broken
    /// when the truth is usually that the bridge is not up yet. Say which it is, in the window.
    func webView(_ wv: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError err: Error) {
        let html = """
        <body style="background:#07090e;color:#e8eef8;font:14px -apple-system;padding:44px;
                     -webkit-user-select:none">
          <h2 style="font-weight:600;margin:0 0 10px">VITALS could not reach its bridge</h2>
          <p style="color:#93a3bd;line-height:1.6;max-width:52ch">
            Nothing answered on <code>127.0.0.1:\(opts.port)</code>. The panel is only a window onto
            the bridge - the bridge is the part that measures. Start it with
            <code>node start.js</code> in the VITALS folder, then reopen this.
          </p>
          <p style="color:#5e6c85;font:11px ui-monospace">\(err.localizedDescription)</p>
        </body>
        """
        wv.loadHTMLString(html, baseURL: nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }
}

// ---------------------------------------------------------------------------- main

let app = NSApplication.shared
let host = Host(Options.parse(Array(CommandLine.arguments.dropFirst())))
app.delegate = host
app.run()
