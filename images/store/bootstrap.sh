#!/usr/bin/env bash
set -euo pipefail
export WP_CLI_CACHE_DIR=/tmp/wp-cli-cache
cd /var/www/html
wp() { command wp --url="$STORE_PUBLIC_URL" "$@"; }
for attempt in $(seq 1 120); do
  [[ -f wp-config.php ]] && php -r '$db = new mysqli(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")); exit($db->connect_errno ? 1 : 0);' >/dev/null 2>&1 && break
  sleep 2
done
if ! wp core is-installed --quiet; then
  wp core install --url="$STORE_PUBLIC_URL" --title='StoreLink Demo Store' \
    --admin_user="$WORDPRESS_ADMIN_USER" --admin_password="$WORDPRESS_ADMIN_PASSWORD" \
    --admin_email='admin@storelink.test' --skip-email --quiet
fi
wp option update home "$STORE_PUBLIC_URL" --quiet
wp option update siteurl "$STORE_PUBLIC_URL" --quiet
wp rewrite structure '/%postname%/' --hard --quiet
if ! wp plugin is-installed woocommerce || [[ $(wp plugin get woocommerce --field=version) != "$WOOCOMMERCE_VERSION" ]]; then
  wp plugin install /opt/woocommerce.zip --force --activate --quiet
else
  wp plugin activate woocommerce --quiet
fi
wp eval-file /opt/storelink/configure.php --quiet
echo 'Store bootstrap complete; existing products and orders were retained.'
