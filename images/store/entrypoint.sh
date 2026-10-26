#!/usr/bin/env bash
set -euo pipefail
# The official entrypoint's copy also tries to set the mode of /var/www/html itself,
# which www-data cannot do on a fresh volume owned by root. Copy only its contents.
if [[ ! -e /var/www/html/index.php && ! -e /var/www/html/wp-includes/version.php ]]; then
  shopt -s dotglob
  cd /usr/src/wordpress
  entries=(*)
  tar --create --file - --owner "$(id -u)" --group "$(id -g)" -- "${entries[@]}" |
    tar --extract --file - --directory /var/www/html --skip-old-files
  cd - >/dev/null
fi
exec docker-entrypoint.sh "$@"
