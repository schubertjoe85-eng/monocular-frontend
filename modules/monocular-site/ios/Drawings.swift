// Copied from Monocular Desktop (src-tauri/geo-lib/Sources/geo-lib/Drawings.swift) - keep the two in step.
// Drawings.swift — reads a PDF drawing set's own line work (vectors, not pixels) and its words, on the device.
// Each sheet gives its dark filled shapes (walls on a floor plan), its coloured lines (windows and door swings) and
// the words Apple Vision reads on it with their positions, all in page points (origin bottom left).
import Foundation
import CoreGraphics
import PDFKit
import Vision

final class DwState { var ctm = CGAffineTransform.identity; var lw: CGFloat = 1; var gray: CGFloat = 0; var rgb: [CGFloat] = [0, 0, 0]; var frgb: [CGFloat] = [0, 0, 0] }
final class DwCtx {
  var stack: [DwState] = [DwState()]; var cur: DwState { stack[stack.count - 1] }
  var path: [[CGPoint]] = []; var sub: [CGPoint] = []
  var segs: [[Double]] = []   // x0,y0,x1,y1,width(pt),gray
  var fills = 0
  var polys: [[String: Any]] = []
}
func dwNum(_ s: CGPDFScannerRef) -> CGFloat? { var v: CGPDFReal = 0; if CGPDFScannerPopNumber(s, &v) { return CGFloat(v) }; return nil }
func dwPt(_ c: DwCtx, _ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y).applying(c.cur.ctm) }
func dwCtx(_ i: UnsafeMutableRawPointer?) -> DwCtx { Unmanaged<DwCtx>.fromOpaque(i!).takeUnretainedValue() }
func dwPopColour(_ s: CGPDFScannerRef) -> [CGFloat]? {
  var v: [CGFloat] = []; var n: CGPDFReal = 0
  while v.count < 4 && CGPDFScannerPopNumber(s, &n) { v.insert(CGFloat(n), at: 0) }
  if v.count == 1 { return [v[0], v[0], v[0]] }
  if v.count == 3 { return v }
  if v.count == 4 { let k = v[3]; return [(1 - v[0]) * (1 - k), (1 - v[1]) * (1 - k), (1 - v[2]) * (1 - k)] }
  return nil
}
func dwStroke(_ c: DwCtx) {
  if c.sub.count > 1 { c.path.append(c.sub) }; c.sub = []
  // the line weight in page points: the CTM scales it
  let sc = sqrt(abs(c.cur.ctm.a * c.cur.ctm.d - c.cur.ctm.b * c.cur.ctm.c)), w = Double(max(c.cur.lw, 0) * sc)
  let col: [Double] = c.cur.rgb.map { Double($0) }
  for p in c.path {
    for k in 1..<p.count {
      let a = p[k - 1], b = p[k]
      if hypot(b.x - a.x, b.y - a.y) <= 0.05 { continue }
      var seg: [Double] = [Double(a.x), Double(a.y), Double(b.x), Double(b.y), w]
      seg.append(contentsOf: col)
      c.segs.append(seg)
    }
  }
  c.path = []
}
func dwEndPath(_ c: DwCtx) { c.path = []; c.sub = [] }
func dwFill(_ c: DwCtx) {
  if c.sub.count > 1 { c.path.append(c.sub) }; c.sub = []
  let col: [Double] = c.cur.frgb.map { Double($0) }
  for p in c.path where p.count >= 3 {
    let pts: [[Double]] = p.map { q in [Double((q.x * 100).rounded() / 100), Double((q.y * 100).rounded() / 100)] }
    c.polys.append(["rgb": col, "pts": pts])
  }
  c.fills += 1; c.path = []
}

private let dwTable: CGPDFOperatorTableRef = {
  let T = CGPDFOperatorTableCreate()!
  CGPDFOperatorTableSetCallback(T, "q") { _, i in let c = dwCtx(i); let n = DwState(); n.ctm = c.cur.ctm; n.lw = c.cur.lw; n.gray = c.cur.gray; n.rgb = c.cur.rgb; n.frgb = c.cur.frgb; c.stack.append(n) }
  CGPDFOperatorTableSetCallback(T, "Q") { _, i in let c = dwCtx(i); if c.stack.count > 1 { c.stack.removeLast() } }
  CGPDFOperatorTableSetCallback(T, "cm") { s, i in let c = dwCtx(i)
    guard let f = dwNum(s), let e = dwNum(s), let d = dwNum(s), let cc = dwNum(s), let b = dwNum(s), let a = dwNum(s) else { return }
    c.cur.ctm = CGAffineTransform(a: a, b: b, c: cc, d: d, tx: e, ty: f).concatenating(c.cur.ctm) }
  CGPDFOperatorTableSetCallback(T, "w") { s, i in let c = dwCtx(i); if let w = dwNum(s) { c.cur.lw = w } }
  CGPDFOperatorTableSetCallback(T, "G") { s, i in let c = dwCtx(i); if let g = dwNum(s) { c.cur.gray = g; c.cur.rgb = [g, g, g] } }
  CGPDFOperatorTableSetCallback(T, "RG") { s, i in let c = dwCtx(i); if let b = dwNum(s), let g = dwNum(s), let r = dwNum(s) { c.cur.gray = (r + g + b) / 3; c.cur.rgb = [r, g, b] } }
  CGPDFOperatorTableSetCallback(T, "K") { s, i in let c = dwCtx(i); if let k = dwNum(s), let y = dwNum(s), let m = dwNum(s), let cy = dwNum(s) { c.cur.rgb = [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; c.cur.gray = c.cur.rgb.reduce(0, +) / 3 } }
  for op in ["SC", "SCN"] { CGPDFOperatorTableSetCallback(T, op) { s, i in let c = dwCtx(i); if let v = dwPopColour(s) { c.cur.rgb = v; c.cur.gray = v.reduce(0, +) / 3 } } }
  for op in ["sc", "scn"] { CGPDFOperatorTableSetCallback(T, op) { s, i in let c = dwCtx(i); if let v = dwPopColour(s) { c.cur.frgb = v } } }
  CGPDFOperatorTableSetCallback(T, "g") { s, i in let c = dwCtx(i); if let g = dwNum(s) { c.cur.frgb = [g, g, g] } }
  CGPDFOperatorTableSetCallback(T, "rg") { s, i in let c = dwCtx(i); if let b = dwNum(s), let g = dwNum(s), let r = dwNum(s) { c.cur.frgb = [r, g, b] } }
  CGPDFOperatorTableSetCallback(T, "k") { s, i in let c = dwCtx(i); if let k = dwNum(s), let y = dwNum(s), let m = dwNum(s), let cy = dwNum(s) { c.cur.frgb = [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)] } }
  CGPDFOperatorTableSetCallback(T, "m") { s, i in let c = dwCtx(i); guard let y = dwNum(s), let x = dwNum(s) else { return }; if c.sub.count > 1 { c.path.append(c.sub) }; c.sub = [dwPt(c, x, y)] }
  CGPDFOperatorTableSetCallback(T, "l") { s, i in let c = dwCtx(i); guard let y = dwNum(s), let x = dwNum(s) else { return }; c.sub.append(dwPt(c, x, y)) }
  CGPDFOperatorTableSetCallback(T, "c") { s, i in let c = dwCtx(i); guard let y = dwNum(s), let x = dwNum(s), let _ = dwNum(s), let _ = dwNum(s), let _ = dwNum(s), let _ = dwNum(s) else { return }; c.sub.append(dwPt(c, x, y)) }
  CGPDFOperatorTableSetCallback(T, "v") { s, i in let c = dwCtx(i); guard let y = dwNum(s), let x = dwNum(s), let _ = dwNum(s), let _ = dwNum(s) else { return }; c.sub.append(dwPt(c, x, y)) }
  CGPDFOperatorTableSetCallback(T, "y") { s, i in let c = dwCtx(i); guard let y = dwNum(s), let x = dwNum(s), let _ = dwNum(s), let _ = dwNum(s) else { return }; c.sub.append(dwPt(c, x, y)) }
  CGPDFOperatorTableSetCallback(T, "h") { _, i in let c = dwCtx(i); if let f = c.sub.first, c.sub.count > 1 { c.sub.append(f) } }
  CGPDFOperatorTableSetCallback(T, "re") { s, i in let c = dwCtx(i); guard let h = dwNum(s), let w = dwNum(s), let y = dwNum(s), let x = dwNum(s) else { return }
    if c.sub.count > 1 { c.path.append(c.sub) }; c.path.append([dwPt(c, x, y), dwPt(c, x + w, y), dwPt(c, x + w, y + h), dwPt(c, x, y + h), dwPt(c, x, y)]); c.sub = [] }
  for op in ["S", "s", "B", "B*", "b", "b*"] { CGPDFOperatorTableSetCallback(T, op) { _, i in dwStroke(dwCtx(i)) } }
  for op in ["f", "F", "f*"] { CGPDFOperatorTableSetCallback(T, op) { _, i in dwFill(dwCtx(i)) } }
  CGPDFOperatorTableSetCallback(T, "n") { _, i in dwEndPath(dwCtx(i)) }
  return T
}()

func readDrawingSetJSON(path: String) -> String {
  func fail(_ m: String) -> String { "{\"ok\":false,\"error\":\"\(m)\"}" }
  let url = URL(fileURLWithPath: path)
  guard let cg = CGPDFDocument(url as CFURL), let doc = PDFDocument(url: url) else { return fail("Couldn't open the PDF.") }
  var pages: [[String: Any]] = []
  for n in 1...max(1, cg.numberOfPages) {
    guard let page = cg.page(at: n), let pk = doc.page(at: n - 1) else { continue }
    let c = DwCtx(), stream = CGPDFContentStreamCreateWithPage(page), sc = CGPDFScannerCreate(stream, dwTable, Unmanaged.passUnretained(c).toOpaque())
    CGPDFScannerScan(sc)
    let box = page.getBoxRect(.mediaBox)
    // keep what the reader uses: dark fills, and lines in colour (black line work stays out: it's most of the file)
    let polys = c.polys.filter { (($0["rgb"] as? [Double]) ?? [1]).max() ?? 1 <= 0.3 }
    // black line work too on sheets light enough to send (roof plans, elevations): shadow studies and the like are huge
    let all = c.segs.count <= 15000
    let segs = c.segs.filter { s in let r = s[5], g = s[6], b = s[7]; return all || max(r, g, b) - min(r, g, b) > 0.25 }.map { $0.map { ($0 * 100).rounded() / 100 } }
    // the words, read off the sheet at about 3600 px on the long edge
    let scale = 3600.0 / max(box.width, box.height), W = Int(box.width * scale), H = Int(box.height * scale)
    var words: [[String: Any]] = []
    if let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
      ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H)); ctx.scaleBy(x: scale, y: scale)
      pk.draw(with: .mediaBox, to: ctx)
      if let img = ctx.makeImage() {
        let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false; req.recognitionLanguages = ["en-AU", "en-US"]; req.minimumTextHeight = 0.003
        try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        for o in req.results ?? [] { guard let t = o.topCandidates(1).first else { continue }; let b = o.boundingBox
          words.append(["s": t.string, "x": Double(b.minX * box.width), "y": Double(b.minY * box.height), "w": Double(b.width * box.width), "h": Double(b.height * box.height)]) }
      }
    }
    pages.append(["page": n, "w": Double(box.width), "h": Double(box.height), "polys": polys, "segs": segs, "allLines": all, "words": words])
  }
  guard let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "pages": pages]), let s = String(data: data, encoding: .utf8) else { return fail("Couldn't encode the drawings.") }
  return s
}
