<?php
// Bootstrap configuration only. MCP tools use WooCommerce's REST API.
update_option('timezone_string', getenv('STORE_TIMEZONE') ?: 'Asia/Kolkata');
update_option('woocommerce_currency', 'INR');
update_option('woocommerce_default_country', 'IN:KA');
update_option('woocommerce_store_address', '1 Demo Road');
update_option('woocommerce_store_city', 'Bengaluru');
update_option('woocommerce_store_postcode', '560001');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_cod_settings', ['enabled' => 'yes', 'title' => 'Cash on delivery', 'description' => 'Pay on delivery (demo).', 'enable_for_methods' => [], 'enable_for_virtual' => 'yes']);
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_pages_only', 'no');
WC_Install::create_pages();
update_option('show_on_front', 'page');
update_option('page_on_front', wc_get_page_id('shop'));
foreach (['cart' => '[woocommerce_cart]', 'checkout' => '[woocommerce_checkout]'] as $page => $content) {
    $id = wc_get_page_id($page);
    if ($id > 0) wp_update_post(['ID' => $id, 'post_content' => $content]);
}
$zone = new WC_Shipping_Zone(0);
$methods = $zone->get_shipping_methods();
$free = false;
foreach ($methods as $method) { if ($method->id === 'free_shipping') $free = true; }
if (!$free) {
    $instance = $zone->add_shipping_method('free_shipping');
    update_option("woocommerce_free_shipping_{$instance}_settings", ['enabled' => 'yes', 'title' => 'Free demo shipping', 'requires' => '']);
}
$integration = get_user_by('login', 'urumi-integration');
if (!$integration) {
    $user_id = wp_insert_user(['user_login' => 'urumi-integration', 'user_pass' => wp_generate_password(48), 'role' => 'shop_manager']);
    if (is_wp_error($user_id)) throw new Exception('Cannot create integration user');
} else { $user_id = $integration->ID; }
global $wpdb;
$consumer_key = getenv('WOO_CONSUMER_KEY');
$consumer_secret = getenv('WOO_CONSUMER_SECRET');
if (!$consumer_key || !$consumer_secret) throw new Exception('Missing store REST credentials');
$hash = wc_api_hash($consumer_key);
$table = $wpdb->prefix . 'woocommerce_api_keys';
if (!$wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash))) {
    $wpdb->insert($table, ['user_id' => $user_id, 'description' => 'Urumi internal MCP adapter', 'permissions' => 'read_write', 'consumer_key' => $hash, 'consumer_secret' => $consumer_secret, 'truncated_key' => substr($consumer_key, -7)]);
}
if (!get_page_by_path('urumi-demo-mug', OBJECT, 'product')) {
    $product = new WC_Product_Simple();
    $product->set_name('Urumi Demo Mug');
    $product->set_slug('urumi-demo-mug');
    $product->set_regular_price('199.00');
    $product->set_status('publish');
    $product->set_description('A demo product for testing checkout and MCP tools.');
    $product->save();
}
flush_rewrite_rules();
update_option('urumi_bootstrap_complete', true);
