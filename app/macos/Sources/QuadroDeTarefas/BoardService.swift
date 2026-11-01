// Garante que o painel está no ar antes de abrir a janela: liga o serviço do launchd e, se ele nem
// estiver instalado, instala pelo bin/service.sh do repositório.
import Foundation

enum BoardService {
    /// Qualquer resposta HTTP conta: sem login, /api/auth/me responde 401, e o painel está no ar.
    static func isUp() async -> Bool {
        var request = URLRequest(url: Config.boardURL.appendingPathComponent("api/auth/me"))
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return response is HTTPURLResponse
        } catch {
            return false
        }
    }

    /// Devolve nil quando o painel respondeu, ou o motivo de não ter respondido.
    static func ensureRunning() async -> String? {
        if await isUp() { return nil }
        if let problem = startService() { return problem }
        for _ in 0..<40 {
            try? await Task.sleep(nanoseconds: 500_000_000)
            if await isUp() { return nil }
        }
        return "O serviço foi ligado, mas o painel não respondeu em 20 segundos. O log do servidor diz o que aconteceu."
    }

    private static func startService() -> String? {
        let kick = run("/bin/launchctl", ["kickstart", "gui/\(getuid())/\(Config.serviceLabel)"])
        if kick.status == 0 { return nil }

        // O serviço não está registrado no launchd: instala, como o README manda fazer uma vez.
        guard let repo = Config.repo else {
            return "O serviço \(Config.serviceLabel) não está instalado. No Terminal, rode bin/service.sh install na pasta do claude-tasks."
        }
        let script = repo.appendingPathComponent("bin/service.sh").path
        guard FileManager.default.isExecutableFile(atPath: script) else {
            return "Não achei \(script). O claude-tasks mudou de pasta? Monte o app de novo com app/macos/build.sh --install."
        }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        if let node = Config.node { env["NODE"] = node }
        let install = run("/bin/bash", [script, "install"], environment: env)
        return install.status == 0 ? nil : "Não deu para instalar o serviço:\n\(install.output.trimmingCharacters(in: .whitespacesAndNewlines))"
    }

    private static func run(_ path: String, _ arguments: [String], environment: [String: String]? = nil) -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (-1, error.localizedDescription)
        }
        // Lê antes de esperar, para uma saída grande não travar o processo.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
