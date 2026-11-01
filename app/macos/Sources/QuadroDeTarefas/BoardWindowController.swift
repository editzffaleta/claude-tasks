// Uma janela com o painel. A principal liga o serviço antes de abrir; as outras nascem de links do
// próprio quadro abertos em nova janela (o mapa em outra aba, a documentação da API).
import AppKit
import WebKit

final class BoardWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let webView: WKWebView
    var onClose: ((BoardWindowController) -> Void)?

    private let isMain: Bool
    private let status = StatusView()
    private var titleObservation: NSKeyValueObservation?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var firstLoadDone = false

    static func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        // Persistente: o login no quadro continua depois de fechar o app.
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "QuadroDeTarefas/1.0"
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        return configuration
    }

    init(configuration: WKWebViewConfiguration = BoardWindowController.makeConfiguration(), isMain: Bool) {
        self.isMain = isMain
        webView = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = Config.appName
        window.minSize = NSSize(width: 760, height: 500)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        super.init(window: window)
        window.delegate = self

        if isMain {
            window.setFrameAutosaveName("QuadroDeTarefas.JanelaPrincipal")
            if !window.setFrameUsingName("QuadroDeTarefas.JanelaPrincipal") { window.center() }
        } else {
            window.setContentSize(NSSize(width: 1180, height: 800))
            window.center()
        }

        let container = NSView()
        for view in [webView, status] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                view.topAnchor.constraint(equalTo: container.topAnchor),
                view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            ])
        }
        window.contentView = container

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            let title = view.title ?? ""
            self?.window?.title = title.isEmpty ? Config.appName : title
        }

        status.onRetry = { [weak self] in self?.start() }
        status.onOpenLog = { AppDelegate.openServerLog() }
        status.hide()
    }

    required init?(coder: NSCoder) { nil }

    /// A janela principal confere o serviço e abre o painel; as outras só esperam o WebKit carregar.
    func start() {
        guard isMain else { return }
        status.showLoading("Ligando o quadro…")
        Task { @MainActor in
            let problem = await Task.detached(priority: .userInitiated) { await BoardService.ensureRunning() }.value
            if let problem {
                self.status.showError("Não deu para abrir o quadro", detail: problem, canOpenLog: Config.serverLog != nil)
                self.saveTestSnapshot()
            } else {
                self.status.showLoading("Abrindo o quadro…")
                self.firstLoadDone = false
                self.webView.load(URLRequest(url: self.webView.url.flatMap { Config.isBoard($0) ? $0 : nil } ?? Config.boardURL))
            }
        }
    }

    // MARK: Menu (chegam pela cadeia de respostas da janela ativa)

    @objc func reloadBoard(_ sender: Any?) {
        if webView.url == nil { start() } else { webView.reload() }
    }

    @objc func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(webView.url ?? Config.boardURL)
    }

    @objc func zoomInPage(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
    @objc func zoomOutPage(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func actualSizePage(_ sender: Any?) { webView.pageZoom = 1 }

    @objc func goBack(_ sender: Any?) { webView.goBack() }
    @objc func goForward(_ sender: Any?) { webView.goForward() }

    // MARK: Janela

    func windowWillClose(_ notification: Notification) {
        onClose?(self)
    }

    // MARK: Navegação

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        let local = Config.isBoard(url) || ["about", "blob", "data"].contains(url.scheme ?? "")
        // O mapa é um iframe do próprio quadro; outros quadros internos de terceiros também carregam ali.
        if local || navigationAction.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        // Links para fora (GitHub, Breakscale, e-mail) abrem no navegador padrão.
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !firstLoadDone {
            firstLoadDone = true
            status.hide()
            saveTestSnapshot()
        }
    }

    /// Para testar sem olhar a tela: QUADRO_FOTO=<arquivo.png> salva uma foto da janela depois de abrir
    /// (ou de mostrar um erro), e QUADRO_FOTO_SAIR=1 fecha o app em seguida.
    private func saveTestSnapshot() {
        let env = ProcessInfo.processInfo.environment
        guard isMain, let path = env["QUADRO_FOTO"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, let content = self.window?.contentView else { return }
            let finish = { (data: Data?) in
                if let data { try? data.write(to: URL(fileURLWithPath: path)) }
                if env["QUADRO_FOTO_SAIR"] == "1" { NSApp.terminate(nil) }
            }
            if !self.status.isHidden {
                guard let rep = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return finish(nil) }
                content.cacheDisplay(in: content.bounds, to: rep)
                finish(rep.representation(using: .png, properties: [:]))
            } else {
                self.webView.takeSnapshot(with: nil) { image, _ in
                    finish(image?.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) })
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    private func showLoadError(_ error: Error) {
        let nsError = error as NSError
        // Cancelamentos e downloads interrompem a navegação de propósito.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        if isMain {
            status.showError("O quadro parou de responder", detail: "\(nsError.localizedDescription)\nO serviço pode estar reiniciando. Tente de novo em alguns segundos.", canOpenLog: Config.serverLog != nil)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Downloads (CSV, arquivo .breakscale, anexos)

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let destination = Self.downloadDestination(for: suggestedFilename)
        downloads[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Faz a pilha de Downloads do Dock pular, como o Safari faz.
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: url.path)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        guard let window else { return }
        let alert = NSAlert(error: error)
        alert.messageText = "O download não terminou"
        alert.beginSheetModal(for: window)
    }

    static func downloadDestination(for suggested: String) -> URL {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        let name = suggested.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name.isEmpty ? "download" : name)
        var n = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }

    // MARK: Novas janelas, arquivos e caixas de diálogo

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, !Config.isBoard(url), url.scheme != "about" {
            NSWorkspace.shared.open(url)
            return nil
        }
        let controller = BoardWindowController(configuration: configuration, isMain: false)
        (NSApp.delegate as? AppDelegate)?.adopt(controller)
        controller.showWindow(nil)
        return controller.webView
    }

    func webViewDidClose(_ webView: WKWebView) {
        if !isMain { window?.close() }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        guard let window else { completionHandler(); return }
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        guard let window else { completionHandler(false); return }
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        guard let window else { completionHandler(nil); return }
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
}
