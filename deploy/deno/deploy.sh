#!/bin/sh
# Publish the addon to Deno Deploy (the host that is not blocked by the video
# servers). Everything here is one command:
#   DENO_DEPLOY_TOKEN=ddo_xxx sh deploy/deno/deploy.sh
#
# Why the copy: Deno Deploy wants the entrypoint next to the bundle, so we build
# a clean upload directory instead of shipping the whole repository.
set -e
cd "$(dirname "$0")/../.."
node src/build-worker.js
rm -rf .deno-upload
mkdir -p .deno-upload
cp worker-addon.js .deno-upload/
sed "s#'../worker-addon.js'#'./worker-addon.js'#" deploy/deno/main.js > .deno-upload/main.js
cd .deno-upload
exec deno deploy --org albrall --app krtoon-zaman --prod --token "$DENO_DEPLOY_TOKEN" -y
