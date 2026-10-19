<?php
// Readiness needs database/configuration state, not a full plugin boot per probe.
define('SHORTINIT', true);
require __DIR__ . '/wp-load.php';
header('Content-Type: application/json');
header('Cache-Control: no-store');
$ready = function_exists('get_option') && get_option('urumi_bootstrap_complete')
    && in_array('woocommerce/woocommerce.php', (array) get_option('active_plugins', []), true);
http_response_code($ready ? 200 : 503);
echo json_encode(['ready' => (bool) $ready]);
