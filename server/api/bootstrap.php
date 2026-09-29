<?php
/**
 * Talentis API — shared bootstrap.
 *
 * Every endpoint includes this first. It loads config from OUTSIDE the web root,
 * opens the database, hardens the session, and provides the JSON and auth
 * helpers. Nothing here prints anything on its own.
 */

declare(strict_types=1);

// Never display raw errors to a browser: they leak paths, queries and versions.
// Everything is caught and returned as clean JSON instead.
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Enquiry times, admission dates and lockouts should read in Indian time, not
// whatever the shared server happens to run on (usually UTC).
date_default_timezone_set('Asia/Kolkata');

require_once __DIR__ . '/lib/fees.php';

// ---------------------------------------------------------------------------
// Config. Looked for above the web root first, which is where it belongs.
// ---------------------------------------------------------------------------
function talentis_load_config(): array
{
    // Walk upward from the api folder looking for talentis-config.php, so it is
    // found wherever it sits above public_html. On Hostinger the web root is
    // /home/uXXX/domains/<domain>/public_html, and a subdomain adds another
    // level, so a fixed depth would be fragile.
    $candidates = [];
    $dir = __DIR__;
    for ($level = 0; $level < 6; $level++) {
        $dir = dirname($dir);
        $candidates[] = $dir . '/talentis-config.php';
        if ($dir === '/' || $dir === '.' || $dir === '') {
            break;
        }
    }
    // Fallback: beside the code. Protected by .htaccess, but less safe.
    $candidates[] = __DIR__ . '/../config.php';
    $candidates[] = __DIR__ . '/config.php';

    foreach ($candidates as $path) {
        if (is_file($path) && is_readable($path)) {
            $config = require $path;
            if (is_array($config)) {
                return $config;
            }
        }
    }

    talentis_fail(
        500,
        'not_configured',
        'config.php was not found. Copy config.sample.php to talentis-config.php '
        . 'above public_html and fill in your database details.'
    );
}

// ---------------------------------------------------------------------------
// JSON output. Every response from this API is JSON, including failures.
// ---------------------------------------------------------------------------
function talentis_json($payload, int $status = 200): void
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store, no-cache, must-revalidate');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        header('X-Frame-Options: DENY');
    }

    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function talentis_ok(array $payload = []): void
{
    talentis_json(array_merge(['ok' => true], $payload));
}

/**
 * Fail with a stable machine-readable code plus a human message. `detail` only
 * appears when debug is on in config, so production never leaks internals.
 */
function talentis_fail(int $status, string $code, string $message, ?string $detail = null): void
{
    $body = ['ok' => false, 'error' => $code, 'message' => $message];

    if ($detail !== null && !empty($GLOBALS['TALENTIS_DEBUG'])) {
        $body['detail'] = $detail;
    }

    talentis_json($body, $status);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
$config = talentis_load_config();
$GLOBALS['TALENTIS_DEBUG'] = !empty($config['debug']);

$security = $config['security'] ?? [];
$requireHttps = (bool)($security['require_https'] ?? true);

$isHttps = (
    (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
    || (($_SERVER['SERVER_PORT'] ?? '') === '443')
);

if ($requireHttps && !$isHttps) {
    talentis_fail(403, 'https_required',
        'This API only accepts HTTPS requests. Enable SSL for the domain.');
}

// Turn unexpected PHP errors into JSON rather than a blank 500 page.
set_exception_handler(static function (Throwable $e): void {
    talentis_fail(500, 'server_error',
        'Something went wrong on the server.', $e->getMessage());
});

set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    throw new ErrorException($str, 0, $no, $file, $line);
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
function talentis_db(array $config): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $db  = $config['db'] ?? [];
    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        $db['host'] ?? 'localhost',
        $db['name'] ?? '',
        $db['charset'] ?? 'utf8mb4'
    );

    try {
        $pdo = new PDO($dsn, (string)($db['user'] ?? ''), (string)($db['password'] ?? ''), [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Real prepared statements, not client-side interpolation.
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        // Match PHP's Asia/Kolkata so NOW(), created_at and the rate-limit
        // windows all agree on what time it is.
        $pdo->exec("SET time_zone = '+05:30'");
    } catch (PDOException $e) {
        talentis_fail(500, 'db_unavailable',
            'Could not connect to the database. Check the details in config.php.',
            $e->getMessage());
    }

    return $pdo;
}

// ---------------------------------------------------------------------------
// Session. Cookie is HttpOnly so JavaScript cannot read it, Secure so it never
// crosses plain HTTP, and SameSite=Strict so another site cannot ride on it.
// ---------------------------------------------------------------------------
function talentis_start_session(array $config, bool $isHttps): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    session_name('talentis_admin');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $isHttps,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();

    // Idle timeout.
    $minutes = (int)($config['security']['session_minutes'] ?? 240);
    $now     = time();
    if (isset($_SESSION['last_seen']) && ($now - (int)$_SESSION['last_seen']) > $minutes * 60) {
        $_SESSION = [];
        session_regenerate_id(true);
    }
    $_SESSION['last_seen'] = $now;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
function talentis_method(): string
{
    return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

function talentis_action(): string
{
    $action = $_GET['action'] ?? '';

    return is_string($action) ? preg_replace('/[^a-z_]/', '', strtolower($action)) : '';
}

/** Read and decode the JSON request body. */
function talentis_body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return $body = [];
    }

    $decoded = json_decode($raw, true);

    return $body = is_array($decoded) ? $decoded : [];
}

/**
 * Reject requests from other origins. Combined with SameSite=Strict this is
 * belt and braces, but a same-origin check is cheap and catches misconfiguration.
 */
function talentis_check_origin(array $config): void
{
    if (talentis_method() === 'GET') {
        return;
    }

    $allowed = $config['allowed_origins'] ?? [];
    $origin  = $_SERVER['HTTP_ORIGIN'] ?? '';

    // Same-origin browser requests may omit Origin; SameSite still covers those.
    if ($origin === '') {
        return;
    }

    if (!in_array($origin, $allowed, true)) {
        talentis_fail(403, 'bad_origin',
            'This request came from an origin that is not allowed.');
    }
}

// ---------------------------------------------------------------------------
// CSRF. A token is minted at login, returned to the client, and must come back
// in a header on every state-changing call.
// ---------------------------------------------------------------------------
function talentis_csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    return (string)$_SESSION['csrf'];
}

function talentis_require_csrf(): void
{
    if (talentis_method() === 'GET') {
        return;
    }

    $sent     = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $expected = (string)($_SESSION['csrf'] ?? '');

    if ($expected === '' || !is_string($sent) || !hash_equals($expected, $sent)) {
        talentis_fail(419, 'csrf_failed',
            'Your session expired. Sign in again.');
    }
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------
function talentis_current_admin(): ?array
{
    if (empty($_SESSION['admin_id'])) {
        return null;
    }

    return [
        'id'    => (int)$_SESSION['admin_id'],
        'email' => (string)($_SESSION['admin_email'] ?? ''),
        'name'  => (string)($_SESSION['admin_name'] ?? ''),
    ];
}

function talentis_require_admin(): array
{
    $admin = talentis_current_admin();
    if ($admin === null) {
        talentis_fail(401, 'not_signed_in', 'Please sign in.');
    }

    return $admin;
}

// ---------------------------------------------------------------------------
// Settings, including the admin-editable fee percentage.
// ---------------------------------------------------------------------------
function talentis_settings(PDO $pdo): array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }

    $defaults = [
        'default_fee_bp'      => 1000,   // 10%
        'registration_amount' => 5000,
        'gst_percent'         => 0,
    ];

    try {
        $rows = $pdo->query('SELECT setting_key, setting_value FROM settings')->fetchAll();
        foreach ($rows as $row) {
            $key = (string)$row['setting_key'];
            if (array_key_exists($key, $defaults)) {
                $defaults[$key] = (int)$row['setting_value'];
            }
        }
    } catch (PDOException $e) {
        // Missing settings table: fall back to defaults rather than break.
    }

    $defaults['default_fee_bp'] = talentis_clean_bp($defaults['default_fee_bp']);

    return $cache = $defaults;
}

function talentis_audit(
    PDO $pdo,
    ?array $admin,
    string $action,
    ?int $candidateId = null,
    ?string $detail = null
): void {
    try {
        $stmt = $pdo->prepare(
            'INSERT INTO audit_log (admin_id, admin_email, action, candidate_id, detail, ip)
             VALUES (:admin_id, :admin_email, :action, :candidate_id, :detail, :ip)'
        );
        $stmt->execute([
            ':admin_id'     => $admin['id'] ?? null,
            ':admin_email'  => $admin['email'] ?? null,
            ':action'       => $action,
            ':candidate_id' => $candidateId,
            ':detail'       => $detail,
            ':ip'           => substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45),
        ]);
    } catch (PDOException $e) {
        // An audit failure must never block the operation it was describing.
    }
}

// Common boot sequence for every endpoint.
//
// Public endpoints (the website's callback form) define TALENTIS_PUBLIC before
// including this file. They get NO session, so a stranger submitting a form
// never receives an admin cookie, and they apply their own origin rules for the
// public site instead of the dashboard-only list.
if (!defined('TALENTIS_PUBLIC')) {
    talentis_start_session($config, $isHttps);
    talentis_check_origin($config);
}
$pdo = talentis_db($config);
