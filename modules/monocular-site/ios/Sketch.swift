import Foundation
// Copied from Monocular Desktop (src-tauri/geo-lib/Sources/geo-lib/Sketch.swift) - keep the two in step.
import Vision
import ImageIO
import CoreGraphics

// Reads a plan sketch (a photo or scan of a hand drawing) on-device with Apple Vision. Returns the closed outlines
// and the written words/numbers with their positions; the frontend decides what they mean. Nothing is guessed here.
//
// Photos of paper have uneven light, so the line work is found against the local paper brightness (an adaptive
// threshold), thickened a little so slightly open corners still close, and the written text is blanked out first so
// digits don't turn into tiny shapes. JSON out, pixel coordinates with y down:
// {"ok":true,"w":..,"h":..,"contours":[{"id":0,"parent":-1,"depth":0,"pts":[[x,y],..]}],
//  "texts":[{"s":"24m","box":[x,y,w,h],"conf":0.9}]}
func readSketchJSON(path: String) -> String {
    func fail(_ msg: String) -> String {
        let m = msg.replacingOccurrences(of: "\\", with: "/").replacingOccurrences(of: "\"", with: "'")
        return "{\"ok\":false,\"error\":\"\(m)\"}"
    }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,   // honour the camera's orientation
        kCGImageSourceThumbnailMaxPixelSize: 2000,
    ]
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
        return fail("Couldn't open the image.")
    }
    let W = img.width, H = img.height

    // --- the writing
    let tr = VNRecognizeTextRequest()
    tr.recognitionLevel = .accurate
    tr.usesLanguageCorrection = false
    tr.recognitionLanguages = ["en-AU", "en-US"]
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([tr])
    var texts: [[String: Any]] = []
    var textRects: [CGRect] = []
    for o in tr.results ?? [] {
        guard let c = o.topCandidates(1).first else { continue }
        let b = o.boundingBox   // normalised, origin bottom left
        let r = CGRect(x: b.minX * CGFloat(W), y: (1 - b.maxY) * CGFloat(H), width: b.width * CGFloat(W), height: b.height * CGFloat(H))
        textRects.append(r)
        texts.append(["s": c.string, "box": [r.minX, r.minY, r.width, r.height].map { Double(Int($0 * 10)) / 10 }, "conf": Double(c.confidence)])
    }

    // --- grey pixels
    var g = [UInt8](repeating: 255, count: W * H)
    guard let gctx = CGContext(data: &g, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W,
                               space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
        return fail("Couldn't read the image pixels.")
    }
    gctx.setFillColor(gray: 1, alpha: 1); gctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    gctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))

    // --- adaptive threshold: dark where clearly darker than the paper around it (integral image box mean)
    let R = max(8, max(W, H) / 30)
    var I = [Int](repeating: 0, count: (W + 1) * (H + 1))
    for y in 0..<H {
        var row = 0
        for x in 0..<W { row += Int(g[y * W + x]); I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row }
    }
    // paper brightness (90th percentile): anything far darker is ink however large, so filled-in blocks stay solid
    var hist = [Int](repeating: 0, count: 256)
    for v in g { hist[Int(v)] += 1 }
    var acc = 0, paper = 255
    for v in 0..<256 { acc += hist[v]; if acc >= W * H * 9 / 10 { paper = v; break } }
    let ink = Double(paper) * 0.45
    var dark = [Bool](repeating: false, count: W * H)
    for y in 0..<H {
        let y0 = max(0, y - R), y1 = min(H, y + R + 1)
        for x in 0..<W {
            let x0 = max(0, x - R), x1 = min(W, x + R + 1)
            let s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]
            let mean = Double(s) / Double((x1 - x0) * (y1 - y0))
            let v = Double(g[y * W + x])
            // pen only: pencil construction lines are fainter (about 0.5-0.85 of the paper around them) and are ignored
            dark[y * W + x] = (v < mean * 0.5 && v < 200) || (v < ink && v < mean * 0.85)   // not a shadow: ink is darker than its surroundings
        }
    }
    // blank the writing (slightly inset, so lines the text touches survive)
    for r in textRects {
        let ix = r.insetBy(dx: r.width * 0.04, dy: r.height * 0.12)
        let xa = max(0, Int(ix.minX)), xb = min(W, Int(ix.maxX)), ya = max(0, Int(ix.minY)), yb = min(H, Int(ix.maxY))
        if xa >= xb || ya >= yb { continue }
        for y in ya..<yb { for x in xa..<xb { dark[y * W + x] = false } }
    }
    // a quarter-size map of all pen ink (pencil and writing left out), for tracing outlines drawn around the walls
    let qs = 4, QW = (W + qs - 1) / qs, QH = (H + qs - 1) / qs
    var qmap = [UInt8](repeating: 0, count: QW * QH)
    for y in 0..<H { for x in 0..<W where dark[y * W + x] { qmap[(y / qs) * QW + x / qs] = 1 } }
    let inkB64 = Data(qmap).base64EncodedString()

    // --- dashes: short separate strokes (a roof outline over the plan is drawn dashed). Find them, take them out of
    // the wall line work, and keep them apart to join up into outlines of their own.
    let big = max(W, H)
    var isDash = [Bool](repeating: false, count: W * H)
    do {
        // label every separate piece of ink, remembering how long each is
        var label = [Int32](repeating: 0, count: W * H)
        var longOf: [Int] = [0]
        var candidates: [(label: Int32, members: [Int], box: (Int, Int, Int, Int))] = []
        var stack: [Int] = []
        var next: Int32 = 1
        for start in 0..<(W * H) where dark[start] && label[start] == 0 {
            var members: [Int] = []
            var x0 = W, x1 = 0, y0 = H, y1 = 0
            label[start] = next; stack.append(start)
            while let i = stack.popLast() {
                if members.count <= big * 2 { members.append(i) }
                let x = i % W, y = i / W
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)] {
                    let nx = x + dx, ny = y + dy
                    if nx < 0 || ny < 0 || nx >= W || ny >= H { continue }
                    let j = ny * W + nx
                    if dark[j] && label[j] == 0 { label[j] = next; stack.append(j) }
                }
            }
            let bw = x1 - x0 + 1, bh = y1 - y0 + 1, long = max(bw, bh), diag = (Double(bw * bw + bh * bh)).squareRoot()
            longOf.append(long)
            let thinness = Double(members.count) / max(1, diag)   // about the stroke width for a straight dash
            // short and thin; two dashes that touch where lines meet (a T or an X) still count
            if long >= big / 220 && long <= big / 18 && thinness < Double(big) / 120 && diag > thinness * 1.6 {
                candidates.append((next, members, (x0, y0, x1, y1)))
            }
            next += 1
        }
        // a dash stands clear of the drawn lines; a short bit right beside a long line is part of that line's drawing
        let r = max(3, big / 250)
        for c in candidates {
            var alone = true
            outer: for y in max(0, c.box.1 - r)...min(H - 1, c.box.3 + r) {
                for x in max(0, c.box.0 - r)...min(W - 1, c.box.2 + r) {
                    let j = y * W + x, l = label[j]
                    if l != 0 && l != c.label && longOf[Int(l)] > big / 18
                        && c.members.contains(where: { abs($0 % W - x) <= r && abs($0 / W - y) <= r }) { alone = false; break outer }
                }
            }
            if alone { for i in c.members { isDash[i] = true } }
        }
    }
    var dashCount = 0
    for i in 0..<(W * H) where isDash[i] { dark[i] = false; dashCount += 1 }
    var dashContours: [[String: Any]] = []
    var dashFacets: [[String: Any]] = []
    var dashBand = 0
    if dashCount > 0 {
        dashBand = max(2, big / 90)   // bridges the gaps between dashes
        var dt = [Bool](repeating: false, count: W * H)
        for y in 0..<H {
            var last = -1_000_000
            for x in 0..<W { if isDash[y * W + x] { last = x }; if x - last <= dashBand { dt[y * W + x] = true } }
            last = 1_000_000
            for x in stride(from: W - 1, through: 0, by: -1) { if isDash[y * W + x] { last = x }; if last - x <= dashBand { dt[y * W + x] = true } }
        }
        var db = [UInt8](repeating: 255, count: W * H)
        for x in 0..<W {
            var last = -1_000_000
            for y in 0..<H { if dt[y * W + x] { last = y }; if y - last <= dashBand { db[y * W + x] = 0 } }
            last = 1_000_000
            for y in stride(from: H - 1, through: 0, by: -1) { if dt[y * W + x] { last = y }; if last - y <= dashBand { db[y * W + x] = 0 } }
        }
        // the enclosed blank regions inside the dashed lines: one per roof slope
        var seen = [Bool](repeating: false, count: W * H)
        var fstack: [Int] = []
        for start in 0..<(W * H) where db[start] == 255 && !seen[start] {
            var n = 0, sx = 0, sy = 0, border = false, x0 = W, x1 = 0, y0 = H, y1 = 0
            seen[start] = true; fstack.append(start)
            while let i = fstack.popLast() {
                let x = i % W, y = i / W
                n += 1; sx += x; sy += y; x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                if x == 0 || y == 0 || x == W - 1 || y == H - 1 { border = true }
                for j in [i - 1, i + 1, i - W, i + W] where j >= 0 && j < W * H && db[j] == 255 && !seen[j] {
                    if (j == i - 1 && x == 0) || (j == i + 1 && x == W - 1) { continue }
                    seen[j] = true; fstack.append(j)
                }
            }
            if !border && Double(n) > Double(W * H) * 0.0008 {
                dashFacets.append(["c": [Double(sx) / Double(n), Double(sy) / Double(n)], "area": n, "box": [x0, y0, x1 - x0 + 1, y1 - y0 + 1]])
            }
        }
        if let dctx = CGContext(data: &db, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
           let dimg = dctx.makeImage() {
            let rq = VNDetectContoursRequest()
            rq.contrastAdjustment = 1.0; rq.detectsDarkOnLight = true; rq.maximumImageDimension = 1600
            if (try? VNImageRequestHandler(cgImage: dimg, options: [:]).perform([rq])) != nil, let o = rq.results?.first {
                func walkD(_ c: VNContour, parent: Int, depth: Int) {
                    guard depth < 6, let sc = try? c.polygonApproximation(epsilon: 0.002) else { return }
                    let pts = sc.normalizedPoints.map { [Double(Int(Double($0.x) * Double(W) * 10)) / 10, Double(Int((1 - Double($0.y)) * Double(H) * 10)) / 10] }
                    var a = 0.0
                    for i in 0..<pts.count { let p = pts[i], q = pts[(i + 1) % pts.count]; a += p[0] * q[1] - q[0] * p[1] }
                    if abs(a) / 2 < Double(W * H) * 0.0008 || pts.count < 3 { return }
                    let id = dashContours.count
                    dashContours.append(["id": id, "parent": parent, "depth": depth, "pts": pts])
                    for ch in c.childContours { walkD(ch, parent: id, depth: depth + 1) }
                }
                for c in o.topLevelContours { walkD(c, parent: -1, depth: 0) }
            }
        }
    }

    // --- bold vs thin: a bold stroke survives an erosion that removes thin ones (walls are drawn bold, glass thin)
    let e = max(2, big / 420)
    func erodeDilate(_ src: [Bool], _ r: Int, erode: Bool) -> [Bool] {
        var tmp = [Bool](repeating: false, count: W * H), out = [Bool](repeating: false, count: W * H)
        for y in 0..<H {   // horizontal pass: run lengths
            var run = 0
            for x in 0..<W { let v = src[y * W + x]; if erode { run = v ? run + 1 : 0; if run > 2 * r { tmp[y * W + x - r] = true } } else { if v { run = 2 * r + 1 }; if run > 0 { tmp[y * W + x] = true; run -= 1 } } }
            if !erode { run = 0; for x in stride(from: W - 1, through: 0, by: -1) { if src[y * W + x] { run = r + 1 }; if run > 0 { tmp[y * W + x] = true; run -= 1 } } }
        }
        for x in 0..<W {
            var run = 0
            for y in 0..<H { let v = tmp[y * W + x]; if erode { run = v ? run + 1 : 0; if run > 2 * r { out[(y - r) * W + x] = true } } else { if v { run = 2 * r + 1 }; if run > 0 { out[y * W + x] = true; run -= 1 } } }
            if !erode { run = 0; for y in stride(from: H - 1, through: 0, by: -1) { if tmp[y * W + x] { run = r + 1 }; if run > 0 { out[y * W + x] = true; run -= 1 } } }
        }
        return out
    }
    let bold = erodeDilate(erodeDilate(dark, e, erode: true), e + 1, erode: false)
    // a quarter-size map of where the bold ink is, for telling solid wall from glazing along each edge
    let bs = 4, BW = (W + bs - 1) / bs, BH = (H + bs - 1) / bs
    var bmap = [UInt8](repeating: 0, count: BW * BH)
    for y in 0..<H { for x in 0..<W where bold[y * W + x] && dark[y * W + x] { bmap[(y / bs) * BW + x / bs] = 1 } }
    let boldB64 = Data(bmap).base64EncodedString()

    // thicken strokes (separable square dilation) so near-closed corners close
    let d = max(1, max(W, H) / 400)
    var tmp = [Bool](repeating: false, count: W * H)
    for y in 0..<H {
        var last = -1_000_000
        for x in 0..<W { if dark[y * W + x] { last = x }; if x - last <= d { tmp[y * W + x] = true } }
        last = 1_000_000
        for x in stride(from: W - 1, through: 0, by: -1) { if dark[y * W + x] { last = x }; if last - x <= d { tmp[y * W + x] = true } }
    }
    var thick = [Bool](repeating: false, count: W * H)
    for x in 0..<W {
        var last = -1_000_000
        for y in 0..<H { if tmp[y * W + x] { last = y }; if y - last <= d { thick[y * W + x] = true } }
        last = 1_000_000
        for y in stride(from: H - 1, through: 0, by: -1) { if tmp[y * W + x] { last = y }; if last - y <= d { thick[y * W + x] = true } }
    }
    var bin = [UInt8](repeating: 255, count: W * H)
    for i in 0..<(W * H) where thick[i] { bin[i] = 0 }
    guard let bctx = CGContext(data: &bin, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W,
                               space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
          let bimg = bctx.makeImage() else { return fail("Couldn't prepare the line work.") }

    // --- outlines
    let cr = VNDetectContoursRequest()
    cr.contrastAdjustment = 1.0
    cr.detectsDarkOnLight = true
    cr.maximumImageDimension = 1600
    do { try VNImageRequestHandler(cgImage: bimg, options: [:]).perform([cr]) }
    catch { return fail("Vision couldn't trace the sketch: \(error.localizedDescription)") }
    guard let obs = cr.results?.first else { return fail("No line work found in the image.") }

    var contours: [[String: Any]] = []
    let minArea = Double(W * H) * 0.0015
    func walk(_ c: VNContour, parent: Int, depth: Int) {
        guard depth < 8, let s = try? c.polygonApproximation(epsilon: 0.0015) else { return }
        let pts = s.normalizedPoints.map { [Double(Int(Double($0.x) * Double(W) * 10)) / 10, Double(Int((1 - Double($0.y)) * Double(H) * 10)) / 10] }
        var a = 0.0
        for i in 0..<pts.count { let p = pts[i], q = pts[(i + 1) % pts.count]; a += p[0] * q[1] - q[0] * p[1] }
        if abs(a) / 2 < minArea || pts.count < 3 { return }   // too small to be a building; its children are smaller still
        let id = contours.count
        contours.append(["id": id, "parent": parent, "depth": depth, "pts": pts])
        for ch in c.childContours { walk(ch, parent: id, depth: depth + 1) }
    }
    for c in obs.topLevelContours { walk(c, parent: -1, depth: 0) }

    // A lone digit in a building ("6") is easy to miss on the whole page, so look again closely inside each outline.
    var seen = textRects
    let regions = contours.compactMap { c -> CGRect? in
        guard let pts = c["pts"] as? [[Double]] else { return nil }
        let xs = pts.map { $0[0] }, ys = pts.map { $0[1] }
        return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    }.filter { $0.width > 30 && $0.height > 30 }.prefix(40)
    for r in regions {
        let cropR = r.insetBy(dx: r.width * 0.03, dy: r.height * 0.03).integral
        guard let crop = img.cropping(to: cropR) else { continue }
        for level in [VNRequestTextRecognitionLevel.accurate, .fast] {
            let q = VNRecognizeTextRequest()
            q.recognitionLevel = level
            q.usesLanguageCorrection = false
            q.minimumTextHeight = 0.02
            try? VNImageRequestHandler(cgImage: crop, options: [:]).perform([q])
            var found = false
            for o in q.results ?? [] {
                guard let c = o.topCandidates(1).first, c.confidence > 0.3 else { continue }
                let s = c.string.trimmingCharacters(in: .whitespaces)
                if s.isEmpty { continue }
                let b = o.boundingBox
                let tr = CGRect(x: cropR.minX + b.minX * cropR.width, y: cropR.minY + (1 - b.maxY) * cropR.height,
                                width: b.width * cropR.width, height: b.height * cropR.height)
                if seen.contains(where: { $0.intersects(tr) }) { found = true; continue }
                seen.append(tr); found = true
                texts.append(["s": s, "box": [tr.minX, tr.minY, tr.width, tr.height].map { Double(Int($0 * 10)) / 10 }, "conf": Double(c.confidence), "close": true])
            }
            if found { break }
        }
    }

    let out: [String: Any] = ["ok": true, "w": W, "h": H, "contours": contours, "texts": texts, "dashed": dashContours, "dashFacets": dashFacets, "dashBand": dashBand,
                              "bold": ["w": BW, "h": BH, "scale": bs, "data": boldB64],
                              "ink": ["w": QW, "h": QH, "scale": qs, "data": inkB64]]
    guard let data = try? JSONSerialization.data(withJSONObject: out), let s = String(data: data, encoding: .utf8) else {
        return fail("Couldn't encode the sketch reading.")
    }
    return s
}
