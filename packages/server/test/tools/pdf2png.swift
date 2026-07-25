// PDF → PNG 逐页转图（macOS 专用，依赖系统 PDFKit，无需安装任何东西）。
// 实验第四步"目检"的工具：数字指标看不出的问题（块间诡异空隙、标题沉底、排版观感）
// 只能转成图后用眼睛看。
//
// 用法: swift test/tools/pdf2png.swift <输入.pdf> <输出前缀>
//   → 生成 <输出前缀>-p1.png、-p2.png …（2x 分辨率）
import PDFKit
import AppKit
let args = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: args[1]))!
for i in 0..<doc.pageCount {
  let page = doc.page(at: i)!
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2.0
  let img = NSImage(size: NSSize(width: bounds.width * scale, height: bounds.height * scale))
  img.lockFocus()
  NSColor.white.setFill()
  NSRect(x: 0, y: 0, width: bounds.width * scale, height: bounds.height * scale).fill()
  let ctx = NSGraphicsContext.current!.cgContext
  ctx.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: ctx)
  img.unlockFocus()
  let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(args[2])-p\(i + 1).png"))
}
