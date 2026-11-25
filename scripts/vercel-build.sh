#!/bin/sh
# Vercel runs this before every deploy. Preview deployments (any branch but
# main, e.g. v2 on blippreview) get the "Blip Preview" install name and icons,
# so an installed preview app is easy to tell apart. Production is untouched.
set -e
if [ "$VERCEL_ENV" = "preview" ]; then
  cp manifest-preview.webmanifest manifest.webmanifest
  for f in app-icon-192 app-icon-512 apple-touch-icon favicon-32; do
    cp "icons/preview/$f.png" "icons/$f.png"
  done
  echo "Preview build: using Blip Preview name and icons"
else
  echo "Production build: normal name and icons"
fi
