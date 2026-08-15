#!/usr/bin/env swift
//
// Turns the two design exports in Design/ into the assets the app bundle wants.
//
//   Scripts/make-icons.swift
//
// Run it by hand when the artwork changes; the outputs are committed, so a plain checkout builds
// without needing to regenerate anything. `Scripts/build-app.sh` picks both of them up on its own.
//
//   Design/AppIcon.png      1254² opaque  ->  Scripts/AppIcon.icns
//   Design/MenuBarIcon.png  1254² alpha   ->  Resources/MenuBar{,@2x,@3x}.png
//
// Two things this has to do that a `sips` one-liner cannot.
//
// The app icon is exported **on an opaque black background** — the squircle is painted onto black
// rather than cut out of it. Dropped into an .icns as-is it is a black square with a cream shape
// inside. So the black is keyed out here. A luminance threshold is the obvious way and the wrong
// one: the caret bar inside the artwork is darker (65) than the threshold would have to be, so a
// threshold punches a hole through the middle of the drawing. A flood fill from the border only
// ever reaches background, which is the actual thing being asked.
//
// And the artwork fills 92% of its canvas, where macOS app icons sit at 824/1024 — 80.5% — with the
// rest as breathing room. An icon that skips that margin renders visibly larger than every other
// icon in the Dock, which reads as a mistake rather than as emphasis. So it is re-inset here.

import AppKit
import CoreGraphics
import Foundation

// ---------------------------------------------------------------------------------------------
// Bitmap
// ---------------------------------------------------------------------------------------------

/// Straight-alpha RGBA8, which is what the keying maths below assumes.
struct Bitmap {
    var pixels: [UInt8]
    let width: Int
    let height: Int

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        pixels = [UInt8](repeating: 0, count: width * height * 4)
    }

    subscript(x: Int, y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8) {
        get {
            let i = (y * width + x) * 4
            return (pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])
        }
        set {
            let i = (y * width + x) * 4
            pixels[i] = newValue.r
            pixels[i + 1] = newValue.g
            pixels[i + 2] = newValue.b
            pixels[i + 3] = newValue.a
        }
    }

    func luminance(_ x: Int, _ y: Int) -> Int {
        let p = self[x, y]
        return (299 * Int(p.r) + 587 * Int(p.g) + 114 * Int(p.b)) / 1000
    }
}

func loadBitmap(_ url: URL) -> Bitmap {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("could not read \(url.path)")
    }

    var bitmap = Bitmap(width: image.width, height: image.height)

    // Backing memory the context owns for its whole life. Reaching into the array with
    // `withUnsafeMutableBytes` and letting the context outlive the closure would hand CoreGraphics a
    // pointer Swift is free to move.
    let byteCount = image.width * image.height * 4
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 4)
    defer { buffer.deallocate() }

    // A bitmap context can only be premultiplied; straight alpha is recovered just below.
    guard let context = CGContext(
        data: buffer,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("could not make a bitmap context")
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    bitmap.pixels.withUnsafeMutableBytes { destination in
        destination.copyMemory(from: UnsafeRawBufferPointer(start: buffer, count: byteCount))
    }

    // Un-premultiply. The source is opaque for the app icon and already black-with-alpha for the
    // menu bar glyph, so this is a no-op in practice — but it keeps the keying below honest if a
    // future export arrives with soft edges.
    for i in stride(from: 0, to: bitmap.pixels.count, by: 4) {
        let a = Int(bitmap.pixels[i + 3])
        guard a > 0, a < 255 else { continue }
        for c in 0..<3 {
            bitmap.pixels[i + c] = UInt8(min(255, Int(bitmap.pixels[i + c]) * 255 / a))
        }
    }
    return bitmap
}

/// Wraps a straight-alpha bitmap as a `CGImage`.
///
/// Via a data provider rather than a bitmap context, because a context cannot hold straight alpha —
/// its only RGBA option is premultiplied — while a `CGImage` is happy to. Going through a context
/// here would premultiply the keyed edge ring a second time and darken it.
func cgImage(_ bitmap: Bitmap) -> CGImage {
    guard let provider = CGDataProvider(data: Data(bitmap.pixels) as CFData) else {
        fail("could not wrap the pixels")
    }
    guard let image = CGImage(
        width: bitmap.width,
        height: bitmap.height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: bitmap.width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
    ) else {
        fail("could not build an image")
    }
    return image
}

func writePNG(_ image: CGImage, to url: URL) {
    try? FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, "public.png" as CFString, 1, nil
    ) else {
        fail("could not write \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("could not finalise \(url.path)") }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(1)
}

// ---------------------------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------------------------

/// Replaces the black background with transparency, without touching dark pixels *inside* the art.
///
/// Flood fill rather than threshold, for the reason in the header: the caret bar in the artwork is
/// darker than any threshold that would also catch the background's antialiased fringe. Reachability
/// from the border is the property that actually distinguishes them.
func keyOutBlackBackground(_ bitmap: Bitmap) -> Bitmap {
    let w = bitmap.width, h = bitmap.height

    // Measured on the current export: background is 0–6, the one antialiased pixel on each edge
    // lands at 96–212, and the darkest interior pixel is 65. 100 sits above the background and its
    // fringe without reaching anything that belongs to the drawing.
    let backgroundCeiling = 100
    // What the squircle is worth right at its edge, for recovering a fractional alpha.
    let edgeReference = 240.0

    var outside = [Bool](repeating: false, count: w * h)
    var stack: [Int] = []

    func consider(_ x: Int, _ y: Int) {
        let i = y * w + x
        guard !outside[i], bitmap.luminance(x, y) < backgroundCeiling else { return }
        outside[i] = true
        stack.append(i)
    }

    for x in 0..<w { consider(x, 0); consider(x, h - 1) }
    for y in 0..<h { consider(0, y); consider(w - 1, y) }

    while let i = stack.popLast() {
        let x = i % w, y = i / w
        if x > 0 { consider(x - 1, y) }
        if x < w - 1 { consider(x + 1, y) }
        if y > 0 { consider(x, y - 1) }
        if y < h - 1 { consider(x, y + 1) }
    }

    var result = bitmap
    for y in 0..<h {
        for x in 0..<w {
            if outside[y * w + x] {
                result[x, y] = (0, 0, 0, 0)
                continue
            }
            // The single partial pixel where the shape meets the background it was painted over.
            // Recovering its coverage keeps the rounded corners smooth instead of stair-stepped.
            let touchesOutside =
                (x > 0 && outside[y * w + x - 1]) || (x < w - 1 && outside[y * w + x + 1])
                || (y > 0 && outside[(y - 1) * w + x]) || (y < h - 1 && outside[(y + 1) * w + x])

            let lum = bitmap.luminance(x, y)
            guard touchesOutside, lum < 230 else { continue }

            let coverage = min(1.0, Double(lum) / edgeReference)
            let p = bitmap[x, y]
            // Composited over black, so the stored colour is already coverage × the real colour.
            func unmix(_ v: UInt8) -> UInt8 {
                UInt8(min(255.0, (Double(v) / max(coverage, 0.05)).rounded()))
            }
            result[x, y] = (unmix(p.r), unmix(p.g), unmix(p.b), UInt8((coverage * 255).rounded()))
        }
    }
    return result
}

/// The tightest rectangle containing every pixel that is not fully transparent.
func inkBounds(_ bitmap: Bitmap) -> CGRect {
    var minX = bitmap.width, maxX = -1, minY = bitmap.height, maxY = -1
    for y in 0..<bitmap.height {
        for x in 0..<bitmap.width where bitmap[x, y].a > 8 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
    guard maxX >= minX, maxY >= minY else { fail("the artwork is entirely transparent") }
    return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
}

/// Draws `image`'s `crop` region centred in a `size`² canvas, scaled so its longest side is `fit`.
func compose(_ image: CGImage, crop: CGRect, canvas: Int, fit: Double) -> CGImage {
    guard let cropped = image.cropping(to: crop) else { fail("crop failed") }

    let scale = fit / Double(max(crop.width, crop.height))
    let w = Double(crop.width) * scale
    let h = Double(crop.height) * scale

    guard let context = CGContext(
        data: nil,
        width: canvas,
        height: canvas,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("could not make a \(canvas)² canvas")
    }

    context.interpolationQuality = .high
    context.draw(
        cropped,
        in: CGRect(
            x: (Double(canvas) - w) / 2,
            y: (Double(canvas) - h) / 2,
            width: w,
            height: h
        )
    )
    guard let out = context.makeImage() else { fail("could not render the canvas") }
    return out
}

/// Resamples a square master down to `size`².
func resize(_ image: CGImage, to size: Int) -> CGImage {
    guard let context = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        fail("could not make a \(size)² canvas")
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    guard let out = context.makeImage() else { fail("resize failed") }
    return out
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

let root = URL(fileURLWithPath: CommandLine.arguments.first.map {
    URL(fileURLWithPath: $0).deletingLastPathComponent().deletingLastPathComponent().path
} ?? FileManager.default.currentDirectoryPath)

let design = root.appendingPathComponent("Design")
let scripts = root.appendingPathComponent("Scripts")
let resources = root.appendingPathComponent("Resources")

// ---- app icon ---------------------------------------------------------------------------------

print("==> App icon")

let appSource = loadBitmap(design.appendingPathComponent("AppIcon.png"))
let keyed = keyOutBlackBackground(appSource)
let keyedImage = cgImage(keyed)
let squircle = inkBounds(keyed)
print("    keyed \(appSource.width)² · artwork \(Int(squircle.width))×\(Int(squircle.height))")

// 824 in 1024 is Apple's own grid for the rounded-rect app icon shape.
let master = compose(keyedImage, crop: squircle, canvas: 1024, fit: 824)

let iconset = scripts.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

// The full set iconutil expects. 512@2x is the 1024 master itself.
for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
                        (256, 1), (256, 2), (512, 1), (512, 2)] {
    let pixels = points * scale
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    writePNG(resize(master, to: pixels), to: iconset.appendingPathComponent(name))
}

let icns = scripts.appendingPathComponent("AppIcon.icns")
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try! iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fail("iconutil failed") }

// The .iconset is an intermediate; the .icns is the artefact worth committing.
try? FileManager.default.removeItem(at: iconset)
print("    wrote Scripts/AppIcon.icns")

// ---- menu bar icon ----------------------------------------------------------------------------

print("==> Menu bar icon")

let menuSource = loadBitmap(design.appendingPathComponent("MenuBarIcon.png"))
let menuImage = cgImage(menuSource)
let glyph = inkBounds(menuSource)
print("    artwork \(Int(glyph.width))×\(Int(glyph.height))")

// 18 pt is the status-item convention, and the glyph sits at 16 of those 18 so it has the same
// optical weight as the system items either side of it. Measured stroke is 5.1% of the artwork's
// width, which lands at ~1.8 px at @2x — in the same range as the SF Symbols it sits next to, so
// the outline holds up at this size without being thickened.
for scale in 1...3 {
    let suffix = scale == 1 ? "" : "@\(scale)x"
    writePNG(
        compose(menuImage, crop: glyph, canvas: 18 * scale, fit: Double(16 * scale)),
        to: resources.appendingPathComponent("MenuBar\(suffix).png")
    )
}
print("    wrote Resources/MenuBar{,@2x,@3x}.png")
