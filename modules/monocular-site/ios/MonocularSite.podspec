Pod::Spec.new do |s|
  s.name           = 'MonocularSite'
  s.version        = '1.0.0'
  s.summary        = 'Apple MapKit satellite snapshot of a site, for Monocular'
  s.description    = 'MKMapSnapshotter satellite image around a coordinate - on-device, no API key.'
  s.author         = ''
  s.homepage       = 'https://monocular-opal.vercel.app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'MapKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,swift}"
end
