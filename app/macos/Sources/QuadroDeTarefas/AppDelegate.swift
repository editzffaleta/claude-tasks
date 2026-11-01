// O app: a janela principal (que fica viva ao ser fechada, para voltar na hora pelo Dock), as janelas
// extras abertas por links do quadro e a barra de menus.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: BoardWindowController?
    private var extraWindows: [BoardWindowController] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.build()
        showMainWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    private func showMainWindow() {
        if let mainWindow {
            mainWindow.showWindow(nil)
            return
        }
        let controller = BoardWindowController(isMain: true)
        mainWindow = controller
        controller.showWindow(nil)
        controller.start()
    }

    /// Guarda uma janela aberta por um link até ela ser fechada.
    func adopt(_ controller: BoardWindowController) {
        extraWindows.append(controller)
        controller.onClose = { [weak self] closed in
            self?.extraWindows.removeAll { $0 === closed }
        }
    }

    // MARK: Menu

    @objc func showBoard(_ sender: Any?) { showMainWindow() }

    @objc func openDocs(_ sender: Any?) { NSWorkspace.shared.open(Config.docsURL) }

    @objc func openLog(_ sender: Any?) { Self.openServerLog() }

    static func openServerLog() {
        guard let log = Config.serverLog, FileManager.default.fileExists(atPath: log.path) else {
            let alert = NSAlert()
            alert.messageText = "Ainda não há log do servidor"
            alert.informativeText = "O log aparece em data/server.log, na pasta do claude-tasks, depois que o serviço roda pela primeira vez."
            alert.runModal()
            return
        }
        // Abre no Console, que acompanha o arquivo enquanto ele cresce.
        let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
        NSWorkspace.shared.open([log], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
    }
}
