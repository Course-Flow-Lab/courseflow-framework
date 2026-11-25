#!/bin/sh
# Run on the server as root; archives contain the database and its private key.
set -eu
umask 077
release_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
cd "$release_dir"
data_dir=${DATA_DIR:-"$release_dir/data"}
backup_root=${BACKUP_ROOT:-"$release_dir/backups"}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="$backup_root/$stamp"
compose() { docker compose --env-file "$release_dir/release.env" -f "$release_dir/compose.yml" "$@"; }
test -s "$data_dir/courseflow.db"
test -s "$data_dir/secret.key"
mkdir -p "$backup_root"
mkdir "$destination"
running=$(compose ps --status running -q api)
resume() {
    if [ -n "$running" ]; then
        compose up -d --no-build --pull never --wait --wait-timeout 120 api
    fi
}
trap resume EXIT
if [ -n "$running" ]; then compose stop api; fi
tar --exclude=./browser-runtime -czf "$destination/data.tar.gz" -C "$data_dir" .
for file in compose.yml release.env release.json chromium-seccomp.json backup.sh; do
    cp "$release_dir/$file" "$destination/$file"
done
if [ -n "${HOST_CONFIG_DIR:-}" ]; then
    mkdir "$destination/host-config"
    cp -R "$HOST_CONFIG_DIR/." "$destination/host-config/"
fi
(cd "$destination" && sha256sum data.tar.gz > SHA256SUMS)
printf '%s\n' "$destination"
