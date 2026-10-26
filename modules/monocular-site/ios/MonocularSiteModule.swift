import ExpoModulesCore
import MapKit
import UIKit

// The real site from Apple Maps (MKMapSnapshotter) - on-device, no API key. Same captures as Monocular Desktop's
// geo-lib: the satellite image for the ground, and the standard map (no labels) whose flat building shapes the
// renderer traces into neighbouring buildings where OpenStreetMap has none.
public class MonocularSiteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MonocularSite")

    // Reads a photographed plan sketch on the phone with Apple Vision - the same reader as desktop (Sketch.swift).
    // Returns its JSON: closed outlines, written words and numbers, dashed lines and line weights. Nothing guessed.
    AsyncFunction("readSketch") { (uri: String, promise: Promise) in
      let path = uri.hasPrefix("file://") ? (URL(string: uri)?.path ?? String(uri.dropFirst(7))) : uri
      DispatchQueue.global(qos: .userInitiated).async {
        promise.resolve(readSketchJSON(path: path))
      }
    }

    // Base64 image (no data: prefix) of a `meters` x `meters` square centred on the coordinate, north up, `size`
    // pixels square. kind "satellite" -> JPEG; kind "map" -> PNG (lossless, the tracing reads exact map colours).
    AsyncFunction("snapshot") { (lat: Double, lng: Double, meters: Double, size: Double, kind: String, promise: Promise) in
      let options = MKMapSnapshotter.Options()
      options.region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: lat, longitude: lng),
        latitudinalMeters: meters,
        longitudinalMeters: meters
      )
      options.size = CGSize(width: size, height: size)
      options.scale = 1
      options.pointOfInterestFilter = .excludingAll
      if kind == "map" {
        options.mapType = .standard
        options.showsBuildings = false
        // the light map always: the tracing looks for Apple's light-mode building grey, even when the phone is in dark mode
        options.traitCollection = UITraitCollection(userInterfaceStyle: .light)
      } else {
        options.mapType = .satellite
      }
      MKMapSnapshotter(options: options).start(with: .main) { snapshot, error in
        guard let snapshot = snapshot else {
          promise.reject("E_SNAPSHOT", error?.localizedDescription ?? "The map image didn't load.")
          return
        }
        let data = kind == "map" ? snapshot.image.pngData() : snapshot.image.jpegData(compressionQuality: 0.85)
        guard let data = data else {
          promise.reject("E_SNAPSHOT", "The map image couldn't be encoded.")
          return
        }
        promise.resolve(data.base64EncodedString())
      }
    }
  }
}
