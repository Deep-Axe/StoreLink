FROM wordpress:cli-php8.3@sha256:36243da432a0f0a3b56dc3240ecee9b159108d71305e7c064d987a20a465bfde AS wpcli
FROM wordpress:php8.3-apache@sha256:81a34254acaa6ff3b9a67268c2745e9a041c4094cbe5ccd35b75ed3bbdc033b5
COPY --from=wpcli /usr/local/bin/wp /usr/local/bin/wp
ARG WOOCOMMERCE_VERSION=11.2.1
ARG WOOCOMMERCE_SHA256
RUN test -n "$WOOCOMMERCE_SHA256" && curl -fsSL "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip" -o /opt/woocommerce.zip \
    && echo "$WOOCOMMERCE_SHA256  /opt/woocommerce.zip" | sha256sum -c -
COPY images/store/bootstrap.sh /opt/storelink/bootstrap.sh
COPY images/store/configure.php /opt/storelink/configure.php
RUN printf 'memory_limit=256M\nupload_max_filesize=16M\npost_max_size=16M\n' > /usr/local/etc/php/conf.d/storelink.ini \
    && printf '<IfModule mpm_prefork_module>\nStartServers 1\nMinSpareServers 1\nMaxSpareServers 2\nMaxRequestWorkers 4\nMaxConnectionsPerChild 500\n</IfModule>\n' > /etc/apache2/mods-available/mpm_prefork.conf
# Apache listens on an unprivileged port so the store runs as www-data.
RUN sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf \
    && sed -i 's/^<VirtualHost \*:80>$/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf \
    && grep -qx 'Listen 8080' /etc/apache2/ports.conf \
    && grep -qx '<VirtualHost \*:8080>' /etc/apache2/sites-available/000-default.conf
USER 33:33
