<?php
/**
 * Talentis API — settings, including the DEFAULT FEE PERCENTAGE.
 *
 *   GET  settings.php               -> current values
 *   POST settings.php?action=save   -> { feePercent: "12.5", registrationAmount: 5000 }
 *
 * Changing the default affects candidates added AFTERWARDS. Existing
 * candidates keep the rate stored on their own row, deliberately: a rate change
 * in March must not silently re-price someone billed in January. To move an
 * existing candidate to a new rate, edit that candidate and set their rate
 * explicitly, which leaves an audit entry.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

$admin  = talentis_require_admin();
$action = talentis_action();

/** Read settings fresh, bypassing the per-request cache in bootstrap. */
function talentis_settings_fresh(PDO $pdo): array
{
    $values = [
        'default_fee_bp'      => 1000,
        'registration_amount' => 5000,
        'gst_percent'         => 0,
    ];

    foreach ($pdo->query('SELECT setting_key, setting_value FROM settings')->fetchAll() as $row) {
        $key = (string)$row['setting_key'];
        if (array_key_exists($key, $values)) {
            $values[$key] = (int)$row['setting_value'];
        }
    }

    $values['default_fee_bp'] = talentis_clean_bp($values['default_fee_bp']);

    return $values;
}

function talentis_settings_payload(array $values): array
{
    return [
        'default_fee_bp'      => $values['default_fee_bp'],
        'default_fee_percent' => talentis_percent_from_bp($values['default_fee_bp']),
        'registration_amount' => $values['registration_amount'],
        'gst_percent'         => $values['gst_percent'],
    ];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
if ($action === '' || $action === 'get') {
    talentis_ok(['settings' => talentis_settings_payload(talentis_settings_fresh($pdo))]);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
if ($action === 'save') {
    if (talentis_method() !== 'POST') {
        talentis_fail(405, 'method_not_allowed', 'Use POST to save settings.');
    }
    talentis_require_csrf();

    $body    = talentis_body();
    $current = talentis_settings_fresh($pdo);
    $updates = [];

    // The fee percentage. Accept either basis points or a percentage figure,
    // because the UI sends a percentage and scripts may prefer basis points.
    if (array_key_exists('feeBp', $body) && is_numeric($body['feeBp'])) {
        $updates['default_fee_bp'] = talentis_clean_bp($body['feeBp']);
    } elseif (array_key_exists('feePercent', $body)) {
        if (!is_numeric($body['feePercent'])) {
            talentis_fail(422, 'bad_percent',
                'Enter the percentage as a number, for example 10 or 12.5.');
        }
        $percent = (float)$body['feePercent'];
        if ($percent < 0 || $percent > 100) {
            talentis_fail(422, 'percent_out_of_range',
                'The percentage must be between 0 and 100.');
        }
        $updates['default_fee_bp'] = talentis_bp_from_percent($body['feePercent']);
    }

    if (array_key_exists('registrationAmount', $body)) {
        if (!is_numeric($body['registrationAmount'])) {
            talentis_fail(422, 'bad_registration',
                'Enter the registration amount in rupees, digits only.');
        }
        $amount = (int)$body['registrationAmount'];
        if ($amount < 0 || $amount > 10000000) {
            talentis_fail(422, 'registration_out_of_range',
                'That registration amount looks wrong.');
        }
        $updates['registration_amount'] = $amount;
    }

    if (array_key_exists('gstPercent', $body)) {
        if (!is_numeric($body['gstPercent'])) {
            talentis_fail(422, 'bad_gst', 'Enter GST as a number, for example 0 or 18.');
        }
        $gst = (int)$body['gstPercent'];
        if ($gst < 0 || $gst > 100) {
            talentis_fail(422, 'gst_out_of_range', 'GST must be between 0 and 100.');
        }
        $updates['gst_percent'] = $gst;
    }

    if ($updates === []) {
        talentis_fail(422, 'nothing_to_save', 'No settings were supplied.');
    }

    $stmt = $pdo->prepare(
        'INSERT INTO settings (setting_key, setting_value, updated_by)
         VALUES (:k, :v, :by)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                 updated_by    = VALUES(updated_by)'
    );

    foreach ($updates as $key => $value) {
        $stmt->execute([
            ':k'  => $key,
            ':v'  => (string)$value,
            ':by' => $admin['email'],
        ]);
    }

    $detail = [];
    foreach ($updates as $key => $value) {
        $was = $current[$key] ?? null;
        $detail[] = sprintf('%s %s->%s', $key, var_export($was, true), $value);
    }
    talentis_audit($pdo, $admin, 'settings_saved', null, implode(' ', $detail));

    $fresh = talentis_settings_fresh($pdo);

    talentis_ok([
        'settings' => talentis_settings_payload($fresh),
        'note'     => 'New rate applies to candidates added from now on. Existing '
            . 'candidates keep their own stored rate until you edit them.',
    ]);
}

talentis_fail(400, 'unknown_action', 'Unknown action. Use get or save.');
