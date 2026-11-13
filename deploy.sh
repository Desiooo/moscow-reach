#!/bin/bash
# Сборка и публикация в ветку gh-pages. Токен берётся из ~/.gh-token.
set -e
cd "$(dirname "$0")"
REPO=${REPO:-Desiooo/moscow-reach}
BASE=/$(basename "$REPO")/ npm run build
T=$(mktemp -d); cp -R dist/. "$T"; touch "$T/.nojekyll"
cd "$T"; git init -q -b gh-pages; git add -A
git -c user.name="${REPO%%/*}" -c user.email="${REPO%%/*}@users.noreply.github.com" commit -qm "deploy"
AUTH=$(printf "x-access-token:%s" "$(cat ~/.gh-token)" | base64)
git -c http.extraheader="Authorization: Basic $AUTH" push -fq "https://github.com/$REPO.git" gh-pages
rm -rf "$T"; echo "ok: https://${REPO%%/*}.github.io/${REPO##*/}/"
