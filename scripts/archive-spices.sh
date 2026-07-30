#!/bin/sh

set -eu

archive_root=${1:-dist}
cd "$archive_root"
export LC_ALL=C

find chronos@geraldo-netto -type f -print0 \
    | sort -z \
    | xargs -0 -r sha256sum > chronos-spices.sha256
chmod 0644 chronos-spices.sha256

tar --sort=name \
    --mtime='@0' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --mode='u+rwX,go+rX,go-w' \
    --format=gnu \
    -cf chronos-spices.tar \
    chronos-spices.sha256 chronos@geraldo-netto
