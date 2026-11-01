// Ponto de entrada: um app AppKit comum, com ícone no Dock e barra de menus.
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
