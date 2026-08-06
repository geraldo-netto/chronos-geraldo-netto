#!/bin/bash

# bash, not sh: `set -o pipefail` does not exist in dash, and the manifest is
# built by a pipeline. Without it the pipeline's status is xargs' alone, so a
# find that fails part-way through — an unreadable subdirectory — was invisible
# under `set -eu`.
set -euo pipefail

archive_root=${1:-dist}
cd "$archive_root"
export LC_ALL=C

# The manifest is the artifact's integrity record, and `sha256sum -c` verifies
# only the lines it is given: a manifest that is short still passes, over a tar
# that carries the files it does not list. So prove the list is not empty and
# that every entry in it reached the manifest, the way the executable-mode check
# in the release job guards itself with a non-empty-file check.
find chronos@geraldo-netto -type f -print0 | sort -z > packaged-files
[[ -s packaged-files ]]

xargs -0 -r sha256sum < packaged-files > chronos-spices.sha256

packaged_count=$(tr -cd '\0' < packaged-files | wc -c)
manifest_count=$(wc -l < chronos-spices.sha256)
(( packaged_count == manifest_count ))

rm packaged-files
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
