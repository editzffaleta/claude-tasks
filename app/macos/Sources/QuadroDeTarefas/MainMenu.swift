// A barra de menus. Sem ela, copiar e colar não funcionam no painel. Os atalhos do próprio quadro
// (⌘K, N, /, C, 1 a 5) ficam livres: nenhum item usa essas teclas.
import AppKit

enum MainMenu {
    static func build() -> NSMenu {
        let bar = NSMenu()
        let name = Config.appName

        let app = submenu(in: bar, title: name)
        app.addItem(withTitle: "Sobre o \(name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let services = NSMenu(title: "Serviços")
        app.addItem(withTitle: "Serviços", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Ocultar \(name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Ocultar Outros", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Mostrar Tudo", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Encerrar \(name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = submenu(in: bar, title: "Arquivo")
        file.addItem(withTitle: "Abrir no Navegador", action: #selector(BoardWindowController.openInBrowser(_:)), keyEquivalent: "o").keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        file.addItem(withTitle: "Fechar Janela", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = submenu(in: bar, title: "Editar")
        edit.addItem(withTitle: "Desfazer", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Refazer", action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Recortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Colar e Manter Estilo", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v").keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Selecionar Tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu(in: bar, title: "Visualizar")
        view.addItem(withTitle: "Recarregar", action: #selector(BoardWindowController.reloadBoard(_:)), keyEquivalent: "r")
        view.addItem(.separator())
        view.addItem(withTitle: "Voltar", action: #selector(BoardWindowController.goBack(_:)), keyEquivalent: "[")
        view.addItem(withTitle: "Avançar", action: #selector(BoardWindowController.goForward(_:)), keyEquivalent: "]")
        view.addItem(.separator())
        view.addItem(withTitle: "Tamanho Real", action: #selector(BoardWindowController.actualSizePage(_:)), keyEquivalent: "0")
        view.addItem(withTitle: "Ampliar", action: #selector(BoardWindowController.zoomInPage(_:)), keyEquivalent: "=")
        view.addItem(withTitle: "Reduzir", action: #selector(BoardWindowController.zoomOutPage(_:)), keyEquivalent: "-")
        view.addItem(.separator())
        view.addItem(withTitle: "Entrar em Tela Cheia", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]

        let window = submenu(in: bar, title: "Janela")
        window.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Quadro de Tarefas", action: #selector(AppDelegate.showBoard(_:)), keyEquivalent: "0").keyEquivalentModifierMask = [.command, .option]
        window.addItem(withTitle: "Trazer Tudo para a Frente", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window

        let help = submenu(in: bar, title: "Ajuda")
        help.addItem(withTitle: "Documentação do Quadro de Tarefas", action: #selector(AppDelegate.openDocs(_:)), keyEquivalent: "")
        help.addItem(withTitle: "Abrir o Log do Servidor", action: #selector(AppDelegate.openLog(_:)), keyEquivalent: "")
        NSApp.helpMenu = help

        return bar
    }

    private static func submenu(in bar: NSMenu, title: String) -> NSMenu {
        let item = NSMenuItem()
        let menu = NSMenu(title: title)
        item.submenu = menu
        bar.addItem(item)
        return menu
    }
}
