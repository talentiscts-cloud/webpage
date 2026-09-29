<?php
/**
 * Talentis API — one-off self test.
 *
 * Open this in a browser ONCE after uploading, to confirm the server is sane:
 * PHP version, config found, database reachable, tables present, and the fee
 * arithmetic producing the agreed numbers.
 *
 * It requires a signed-in admin, so it cannot be used to probe the server
 * anonymously. DELETE THIS FILE once you are satisfied. It reveals nothing
 * secret, but a diagnostic endpoint is not something to leave lying around.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

talentis_require_admin();

$checks = [];

function talentis_check(string $name, bool $pass, string $note = ''): void
{
    global $checks;
    $checks[] = ['check' => $name, 'pass' => $pass, 'note' => $note];
}

// -- Environment ------------------------------------------------------------
talentis_check(
    'PHP 7.4 or newer',
    PHP_VERSION_ID >= 70400,
    'running ' . PHP_VERSION
);
talentis_check('PDO MySQL driver', extension_loaded('pdo_mysql'));
talentis_check('mbstring extension', extension_loaded('mbstring'));
talentis_check(
    'bcrypt available',
    defined('PASSWORD_DEFAULT') && password_hash('x', PASSWORD_DEFAULT) !== ''
);
talentis_check(
    'request is HTTPS',
    (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'),
    'sessions must not travel over plain HTTP'
);
talentis_check(
    'debug mode is off',
    empty($config['debug']),
    'set debug => false in config.php before going live'
);

// -- Database ---------------------------------------------------------------
$tables = ['admins', 'candidates', 'instalments', 'settings', 'audit_log'];
foreach ($tables as $table) {
    try {
        $pdo->query('SELECT 1 FROM ' . $table . ' LIMIT 1');
        talentis_check('table ' . $table . ' exists', true);
    } catch (PDOException $e) {
        talentis_check('table ' . $table . ' exists', false, 'run schema.sql');
    }
}

try {
    $count = (int)$pdo->query('SELECT COUNT(*) FROM admins')->fetchColumn();
    talentis_check('at least one admin account', $count > 0, $count . ' found');
} catch (PDOException $e) {
    talentis_check('at least one admin account', false, 'admins table unreadable');
}

// -- Fee arithmetic, the numbers that matter -------------------------------
$settings = talentis_settings($pdo);
$bp       = (int)$settings['default_fee_bp'];

talentis_check(
    'default rate readable',
    $bp > 0,
    talentis_percent_from_bp($bp) . '% (' . $bp . ' basis points)'
);

$fee = talentis_placement_fee(453100, 1000);
talentis_check('10% of 453100 = 45310', $fee === 45310, 'got ' . $fee);

$split = talentis_split_amount(45310, 3);
talentis_check(
    '45310 over 3 EMIs = 15104 + 15103 + 15103',
    $split === [15104, 15103, 15103],
    implode(' + ', $split)
);
talentis_check(
    'instalments sum exactly to the fee',
    array_sum($split) === 45310,
    'sum ' . array_sum($split)
);

$fractional = talentis_placement_fee(453100, 1250);
talentis_check(
    'a fractional rate works: 12.5% of 453100 = 56638',
    $fractional === 56638,
    'got ' . $fractional
);

talentis_check(
    'rate is capped at 100%',
    talentis_clean_bp(999999) === 10000
);

$clamped = talentis_placement_fee(-500, 1000);
talentis_check('negative CTC yields 0', $clamped === 0, 'got ' . $clamped);

// -- Result -----------------------------------------------------------------
$failed = array_values(array_filter($checks, static fn(array $c): bool => !$c['pass']));

talentis_json([
    'ok'      => $failed === [],
    'summary' => sprintf(
        '%d of %d checks passed',
        count($checks) - count($failed),
        count($checks)
    ),
    'failed'  => array_map(static fn(array $c): string => $c['check'], $failed),
    'checks'  => $checks,
    'next'    => $failed === []
        ? 'All good. Delete selftest.php now.'
        : 'Fix the failures above, then reload this page.',
], $failed === [] ? 200 : 500);
