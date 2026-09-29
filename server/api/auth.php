<?php
/**
 * Talentis API — authentication.
 *
 *   GET  auth.php?action=me       -> who is signed in, plus a CSRF token
 *   POST auth.php?action=login    -> { email, password }
 *   POST auth.php?action=logout
 *
 * Passwords are verified against a bcrypt hash with password_verify(). No
 * password is ever stored, logged, or comparable by string equality. Repeated
 * failures rest the account for a while, which blunts brute forcing without
 * locking a real admin out for long.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

$action   = talentis_action();
$settings = talentis_settings($pdo);

// ---------------------------------------------------------------------------
// Who am I? Also how the client gets a CSRF token for later writes.
// ---------------------------------------------------------------------------
if ($action === 'me') {
    $admin = talentis_current_admin();

    if ($admin === null) {
        talentis_json([
            'ok'          => true,
            'signed_in'   => false,
            'server_time' => date('c'),
        ]);
    }

    talentis_ok([
        'signed_in'   => true,
        'admin'       => $admin,
        'csrf'        => talentis_csrf_token(),
        'settings'    => [
            'default_fee_bp'      => $settings['default_fee_bp'],
            'default_fee_percent' => talentis_percent_from_bp($settings['default_fee_bp']),
            'registration_amount' => $settings['registration_amount'],
            'gst_percent'         => $settings['gst_percent'],
        ],
        'server_time' => date('c'),
    ]);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------
if ($action === 'login') {
    if (talentis_method() !== 'POST') {
        talentis_fail(405, 'method_not_allowed', 'Use POST to sign in.');
    }

    $body     = talentis_body();
    $email    = trim((string)($body['email'] ?? ''));
    // Trimmed on purpose: copying a password drags whitespace along with it,
    // and a silent mismatch on an invisible character is miserable to debug.
    $password = trim((string)($body['password'] ?? ''));

    if ($email === '' || $password === '') {
        talentis_fail(422, 'missing_fields', 'Enter both your email and password.');
    }

    $stmt = $pdo->prepare(
        'SELECT id, email, password_hash, full_name, is_active,
                failed_attempts, locked_until
         FROM admins
         WHERE email = :email
         LIMIT 1'
    );
    $stmt->execute([':email' => $email]);
    $admin = $stmt->fetch();

    $maxAttempts = (int)($config['security']['max_failed_attempts'] ?? 6);
    $lockMinutes = (int)($config['security']['lockout_minutes'] ?? 15);

    // Deliberately uniform failure message below: revealing whether an address
    // exists would let someone enumerate accounts.
    $genericFailure = 'Those details do not match. The password is case-sensitive.';

    if ($admin === false) {
        // Spend roughly the time a hash check would, so a missing account is
        // not obviously faster than a wrong password.
        password_verify($password, '$2y$10$usesomesillystringfore7hnbRJHxXVLeakoG8K30M1MlVkd3TRu');
        talentis_fail(401, 'bad_credentials', $genericFailure);
    }

    if ((int)$admin['is_active'] !== 1) {
        talentis_fail(403, 'account_disabled', 'That account is disabled.');
    }

    if (!empty($admin['locked_until']) && strtotime((string)$admin['locked_until']) > time()) {
        $waitSeconds = strtotime((string)$admin['locked_until']) - time();
        talentis_fail(429, 'locked_out', sprintf(
            'Too many failed attempts. Try again in about %d minute(s).',
            max(1, (int)ceil($waitSeconds / 60))
        ));
    }

    if (!password_verify($password, (string)$admin['password_hash'])) {
        $attempts = (int)$admin['failed_attempts'] + 1;
        $lockUntil = null;
        if ($attempts >= $maxAttempts) {
            $lockUntil = date('Y-m-d H:i:s', time() + ($lockMinutes * 60));
            $attempts  = 0;   // reset the counter alongside the lock
        }

        $upd = $pdo->prepare(
            'UPDATE admins SET failed_attempts = :attempts, locked_until = :locked
             WHERE id = :id'
        );
        $upd->execute([
            ':attempts' => $attempts,
            ':locked'   => $lockUntil,
            ':id'       => (int)$admin['id'],
        ]);

        talentis_audit($pdo, null, 'login_failed', null, 'email=' . $email);

        if ($lockUntil !== null) {
            talentis_fail(429, 'locked_out', sprintf(
                'Too many failed attempts. The account is locked for %d minutes.',
                $lockMinutes
            ));
        }

        talentis_fail(401, 'bad_credentials', $genericFailure);
    }

    // Success. New session id, so a token captured before login is useless.
    session_regenerate_id(true);

    $_SESSION['admin_id']    = (int)$admin['id'];
    $_SESSION['admin_email'] = (string)$admin['email'];
    $_SESSION['admin_name']  = (string)($admin['full_name'] ?? '');
    $_SESSION['last_seen']   = time();
    unset($_SESSION['csrf']);

    $pdo->prepare(
        'UPDATE admins
         SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW()
         WHERE id = :id'
    )->execute([':id' => (int)$admin['id']]);

    // Opportunistically upgrade an old hash to the current cost factor.
    if (password_needs_rehash((string)$admin['password_hash'], PASSWORD_DEFAULT)) {
        $pdo->prepare('UPDATE admins SET password_hash = :hash WHERE id = :id')
            ->execute([
                ':hash' => password_hash($password, PASSWORD_DEFAULT),
                ':id'   => (int)$admin['id'],
            ]);
    }

    talentis_audit($pdo, talentis_current_admin(), 'login_ok');

    talentis_ok([
        'signed_in' => true,
        'admin'     => talentis_current_admin(),
        'csrf'      => talentis_csrf_token(),
        'settings'  => [
            'default_fee_bp'      => $settings['default_fee_bp'],
            'default_fee_percent' => talentis_percent_from_bp($settings['default_fee_bp']),
            'registration_amount' => $settings['registration_amount'],
            'gst_percent'         => $settings['gst_percent'],
        ],
    ]);
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------
if ($action === 'logout') {
    if (talentis_method() !== 'POST') {
        talentis_fail(405, 'method_not_allowed', 'Use POST to sign out.');
    }

    $admin = talentis_current_admin();
    if ($admin !== null) {
        talentis_audit($pdo, $admin, 'logout');
    }

    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 42000,
            'path'     => $params['path'],
            'secure'   => $params['secure'],
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }
    session_destroy();

    talentis_ok(['signed_in' => false]);
}

talentis_fail(400, 'unknown_action',
    'Unknown action. Use me, login, or logout.');
