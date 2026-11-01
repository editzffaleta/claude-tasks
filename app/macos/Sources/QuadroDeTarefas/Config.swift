// O que o build.sh grava no Info.plist: o endereço do painel, a pasta do repositório e o Node.
import Foundation

enum Config {
    static let appName = "Quadro de Tarefas"
    static let serviceLabel = "com.claude-tasks.dashboard"

    private static func info(_ key: String) -> String? {
        let value = Bundle.main.object(forInfoDictionaryKey: key) as? String
        return value?.isEmpty == false ? value : nil
    }

    /// O painel. CLAUDE_TASKS_URL no ambiente passa por cima (útil para testar com outro quadro).
    static let boardURL: URL = {
        let text = ProcessInfo.processInfo.environment["CLAUDE_TASKS_URL"] ?? info("ClaudeTasksURL") ?? "http://localhost:4317"
        return URL(string: text) ?? URL(string: "http://localhost:4317")!
    }()

    /// A pasta do claude-tasks, para instalar o serviço e abrir o log quando o painel não liga.
    static let repo: URL? = info("ClaudeTasksRepo").map { URL(fileURLWithPath: $0, isDirectory: true) }

    /// O Node usado pelo serviço: um app aberto pelo Dock não tem o PATH do Terminal.
    static let node: String? = info("ClaudeTasksNode")

    static var serverLog: URL? { repo?.appendingPathComponent("data/server.log") }
    static let docsURL = URL(string: "https://github.com/editzffaleta/claude-tasks#readme")!

    /// Endereços do próprio quadro ficam no app; o resto abre no navegador padrão.
    static func isBoard(_ url: URL) -> Bool {
        url.scheme == boardURL.scheme && url.host == boardURL.host && (url.port ?? defaultPort(url)) == (boardURL.port ?? defaultPort(boardURL))
    }

    private static func defaultPort(_ url: URL) -> Int { url.scheme == "https" ? 443 : 80 }
}
