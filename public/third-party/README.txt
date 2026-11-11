HEIC decoder notices and source

Card Cabinet uses libheif-js 1.23.5 for local HEIC/HEIF conversion. It includes
libheif and libde265, licensed under the GNU Lesser General Public License v3.
The browser loads this library only when its native image decoder cannot read
a HEIC/HEIF photo. Conversion runs on the device. No conversion service is used.

libheif-js 1.23.5
Author: Kiril Vatev and contributors.
License: libheif-js-LICENSE.txt, copied unchanged from the npm package.
Exact source:
https://github.com/catdad-experiments/libheif-js/tree/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d
Source archive:
https://github.com/catdad-experiments/libheif-js/archive/d8ec4bc3bc5bf8055975577bccbbc7e1d7313c2d.tar.gz
Published package:
https://registry.npmjs.org/libheif-js/-/libheif-js-1.23.5.tgz

libheif 1.23.5
Copyright (c) 2017-2025 Dirk Farin and contributors.
License: libheif-LICENSE.txt, copied unchanged from the packaged WASM build.
This file includes the LGPLv3 and GPLv3 license texts.
Exact source used by the upstream Emscripten build:
https://github.com/strukturag/libheif/tree/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00
Source archive:
https://github.com/strukturag/libheif/archive/413e2a87e6a70b3eccc3a3adc5801179dd2d9e00.tar.gz
Build scripts and packaging:
https://github.com/catdad-experiments/libheif-emscripten/tree/v1.23.5
https://github.com/catdad-experiments/libheif-emscripten/archive/refs/tags/v1.23.5.tar.gz

libde265 1.0.15
Copyright (c) 2013-2014 struktur AG, Dirk Farin and contributors.
License: libde265-LICENSE.txt, copied unchanged from upstream COPYING.
Source:
https://github.com/strukturag/libde265/tree/v1.0.15
Source archive used by the libheif build script:
https://github.com/strukturag/libde265/releases/download/v1.0.15/libde265-1.0.15.tar.gz

Separate library asset

The production app preserves libheif-js/libheif-wasm/libheif-bundle.mjs as an
unmodified file named assets/libheif-bundle-<hash>.mjs. It contains its WASM
binary. The worker imports it at runtime through its documented module factory.
The library can be replaced with an interface-compatible version. The source
and build scripts above can be used to rebuild it. In a local app checkout,
replace node_modules/libheif-js/libheif-wasm/libheif-bundle.mjs and run npm run
build. The app source, package lock and build configuration are in its public
repository. After replacing a deployed asset, rebuild the service worker or
clear its cache so that the replacement is loaded.

The app's CC BY-NC-ND 4.0 license does not apply to these third-party libraries
or restrict their modification. You may replace or relink these libraries and
reverse engineer the combined work to debug modifications to the libraries,
as permitted by the LGPL. No additional restrictions in the app's license or
notices limit those LGPL rights. These libraries are provided without warranty;
see the accompanying licenses for the complete terms.
