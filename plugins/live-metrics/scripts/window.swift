// ZCode Live Metrics — native floating window (macOS, WKWebView).
// Usage: /usr/bin/swift window.swift <dashboardUrl> <dashboardJsonPath>
// Watches dashboard.json (the daemon's claim file, see ADR-0001): reloads on
// url/bootId change, self-exits after 90s without a live engine.
import AppKit
import WebKit
import Darwin

guard CommandLine.arguments.count >= 3 else { exit(2) }
let dashboardUrl = CommandLine.arguments[1]
let dashboardJsonPath = CommandLine.arguments[2]

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let width: CGFloat = 384
let height: CGFloat = 620
let mask: NSWindow.StyleMask = [.titled, .closable, .resizable, .miniaturizable]
let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                   styleMask: mask, backing: .buffered, defer: false)
win.title = "Live Metrics"
win.level = .floating
win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
win.isReleasedWhenClosed = false
if let screen = NSScreen.main {
    let f = screen.visibleFrame
    win.setFrameOrigin(NSPoint(x: f.maxX - width - 12, y: f.maxY - height - 12))
}

let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))
win.contentView = webView

func loadDashboard() {
    if let url = URL(string: dashboardUrl) {
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
    }
}
loadDashboard()
win.orderFrontRegardless()
app.activate(ignoringOtherApps: false)

func readClaim() -> (url: String, bootId: String, pid: Int)? {
    guard let data = FileManager.default.contents(atPath: dashboardJsonPath),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let url = obj["url"] as? String, let pid = obj["pid"] as? Int
    else { return nil }
    return (url, obj["bootId"] as? String ?? "", pid)
}

var lastUrl = ""
var lastBoot = ""
var deadSince: Date? = nil
if let c = readClaim() { lastUrl = c.url; lastBoot = c.bootId }

Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
    guard let claim = readClaim(), kill(claim.pid, 0) == 0 else {
        if deadSince == nil { deadSince = Date() }
        if Date().timeIntervalSince(deadSince!) > 90 { exit(0) }
        return
    }
    deadSince = nil
    if claim.url != lastUrl || claim.bootId != lastBoot {
        lastUrl = claim.url
        lastBoot = claim.bootId
        loadDashboard()
    }
}

app.run()
