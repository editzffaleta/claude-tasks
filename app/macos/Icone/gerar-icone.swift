// Desenha o ícone do app (o mesmo ✓ laranja do painel, na grade dos ícones do macOS) em todos os
// tamanhos de um .iconset. uso: swift gerar-icone.swift <pasta.iconset>
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

func render(_ pixels: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(pixels) / 1024

    // Corpo de 824 × 824 com o canto arredondado dos ícones do macOS, um pouco acima do centro por causa da sombra.
    let body = NSRect(x: 100 * s, y: 112 * s, width: 824 * s, height: 824 * s)
    let shape = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowBlurRadius = 24 * s
    shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
    shadow.set()
    color(0xD97757).setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting: color(0xE88E6B), ending: color(0xC9603D))!.draw(in: shape, angle: -90)

    // O ✓ do logo do painel (caminho M9 16.5 L13.5 21 L23 11.5 numa grade de 32), em branco.
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: body.minX + x / 32 * body.width, y: body.maxY - y / 32 * body.height)
    }
    let check = NSBezierPath()
    check.move(to: point(9, 16.5))
    check.line(to: point(13.5, 21))
    check.line(to: point(23, 11.5))
    check.lineWidth = 3.2 / 32 * body.width
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    NSColor.white.setStroke()
    check.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for (name, pixels) in [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
] {
    try render(pixels).write(to: output.appendingPathComponent("\(name).png"))
}
