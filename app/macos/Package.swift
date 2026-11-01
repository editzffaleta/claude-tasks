// swift-tools-version: 5.9
// O app "Quadro de Tarefas" para Mac: uma janela nativa com o painel do quadro. Monte com build.sh.
import PackageDescription

let package = Package(
    name: "QuadroDeTarefas",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "QuadroDeTarefas", path: "Sources/QuadroDeTarefas"),
    ]
)
