// A tela que cobre a janela enquanto o painel liga, ou quando ele não responde.
import AppKit

final class StatusView: NSView {
    var onRetry: (() -> Void)?
    var onOpenLog: (() -> Void)?

    private let spinner = NSProgressIndicator()
    private let titleLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let buttons = NSStackView()

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true

        let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 72).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 72).isActive = true

        spinner.style = .spinning
        spinner.controlSize = .small

        titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLabel.alignment = .center
        detailLabel.font = .systemFont(ofSize: 12.5)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.alignment = .center
        detailLabel.preferredMaxLayoutWidth = 420

        let retry = NSButton(title: "Tentar de novo", target: self, action: #selector(retryTapped))
        retry.bezelStyle = .rounded
        retry.keyEquivalent = "\r"
        let log = NSButton(title: "Abrir o log do servidor", target: self, action: #selector(logTapped))
        log.bezelStyle = .rounded
        buttons.orientation = .horizontal
        buttons.spacing = 10
        buttons.addArrangedSubview(log)
        buttons.addArrangedSubview(retry)

        let stack = NSStackView(views: [icon, titleLabel, spinner, detailLabel, buttons])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.setCustomSpacing(18, after: icon)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -20),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 460),
        ])
    }

    required init?(coder: NSCoder) { nil }

    // A cor de fundo acompanha o tema claro ou escuro do sistema.
    override var wantsUpdateLayer: Bool { true }
    override func updateLayer() { layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }

    // A tela de espera não deixa cliques passarem para o painel embaixo.
    override func hitTest(_ point: NSPoint) -> NSView? { isHidden ? nil : (super.hitTest(point) ?? self) }

    func showLoading(_ text: String) {
        isHidden = false
        titleLabel.stringValue = text
        spinner.isHidden = false
        spinner.startAnimation(nil)
        detailLabel.isHidden = true
        buttons.isHidden = true
    }

    func showError(_ title: String, detail: String, canOpenLog: Bool) {
        isHidden = false
        titleLabel.stringValue = title
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        detailLabel.stringValue = detail
        detailLabel.isHidden = false
        buttons.isHidden = false
        buttons.arrangedSubviews.first?.isHidden = !canOpenLog
    }

    func hide() {
        spinner.stopAnimation(nil)
        isHidden = true
    }

    @objc private func retryTapped() { onRetry?() }
    @objc private func logTapped() { onOpenLog?() }
}
