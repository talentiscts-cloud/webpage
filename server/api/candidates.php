<?php
/**
 * Talentis API — candidates.
 *
 *   GET  candidates.php                -> every candidate with schedule + totals
 *   POST candidates.php?action=save    -> create or update, returns the saved row
 *   POST candidates.php?action=delete  -> { id }
 *
 * Money is never taken from the request. The client may send a fee or an
 * instalment amount; it is ignored. Everything is recomputed from ctc and
 * fee_bp by lib/fees.php, which is the only place fee maths happens.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

$admin    = talentis_require_admin();
$settings = talentis_settings($pdo);
$action   = talentis_action();

/** Allowed status values, mirroring the ENUM in schema.sql. */
const TALENTIS_STATUSES = ['training', 'placed', 'withdrawn'];

/** Normalise a date coming from the client to Y-m-d, or null. */
function talentis_clean_date($value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = trim($value);
    if ($value === '') {
        return null;
    }
    $parts = explode('-', $value);
    if (count($parts) !== 3) {
        return null;
    }
    [$y, $m, $d] = array_map('intval', $parts);
    if (!checkdate($m, $d, $y)) {
        return null;
    }

    return sprintf('%04d-%02d-%02d', $y, $m, $d);
}

function talentis_clean_text($value, int $max): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = trim($value);
    if ($value === '') {
        return null;
    }

    return mb_substr($value, 0, $max);
}

/**
 * Load one candidate with its instalments and computed totals.
 */
function talentis_fetch_candidate(PDO $pdo, int $id, array $settings): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM candidates WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if ($row === false) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT seq, amount, due_date, paid, paid_amount, paid_date
         FROM instalments WHERE candidate_id = :id ORDER BY seq'
    );
    $stmt->execute([':id' => $id]);
    $instalments = $stmt->fetchAll();

    return talentis_shape_candidate($row, $instalments, $settings);
}

/**
 * Turn database rows into the shape the dashboard expects. Totals are computed
 * here, so the client never has to trust or recompute them.
 */
function talentis_shape_candidate(array $row, array $instalments, array $settings): array
{
    $ctc   = (int)$row['ctc'];
    $bp    = talentis_clean_bp((int)$row['fee_bp']);
    $regAmt = (int)$row['registration_amount'];

    $totals = talentis_candidate_totals(
        $ctc,
        $bp,
        (int)$row['registration_paid'] === 1,
        $regAmt,
        $instalments,
        (int)$settings['gst_percent']
    );

    return [
        'id'                  => (int)$row['id'],
        'name'                => (string)$row['name'],
        'phone'               => $row['phone'],
        'email'               => $row['email'],
        'track'               => $row['track'],
        'status'              => (string)$row['status'],
        'admissionDate'       => $row['admission_date'],
        'registrationAmount'  => $regAmt,
        'registrationPaid'    => (int)$row['registration_paid'] === 1,
        'registrationDate'    => $row['registration_date'],
        'employer'            => $row['employer'],
        'joiningDate'         => $row['joining_date'],
        'firstSalaryDate'     => $row['first_salary_date'],
        'ctc'                 => $ctc,
        'feeBp'               => $bp,
        'feePercent'          => talentis_percent_from_bp($bp),
        'placementFee'        => $totals['fee'],
        'paid'                => $totals['paid'],
        'pending'             => $totals['pending'],
        'registrationCollected' => $totals['registration'],
        'totalBilled'         => $totals['total_billed'],
        'emiCount'            => (int)$row['emi_count'],
        'emiStart'            => $row['emi_start'],
        'notes'               => $row['notes'],
        'createdAt'           => $row['created_at'],
        'emis'                => array_map(static function (array $i): array {
            return [
                'n'          => (int)$i['seq'],
                'amount'     => (int)$i['amount'],
                'dueDate'    => $i['due_date'],
                'paid'       => (int)$i['paid'] === 1,
                'paidAmount' => (int)$i['paid_amount'],
                'paidDate'   => $i['paid_date'],
            ];
        }, $instalments),
    ];
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
if ($action === '' || $action === 'list') {
    $rows = $pdo->query('SELECT * FROM candidates ORDER BY name')->fetchAll();

    $schedules = [];
    $stmt = $pdo->query(
        'SELECT candidate_id, seq, amount, due_date, paid, paid_amount, paid_date
         FROM instalments ORDER BY candidate_id, seq'
    );
    foreach ($stmt->fetchAll() as $i) {
        $schedules[(int)$i['candidate_id']][] = $i;
    }

    $candidates = [];
    $summary = [
        'total' => 0, 'training' => 0, 'placed' => 0, 'withdrawn' => 0,
        'registrationCollected' => 0, 'placementCollected' => 0, 'outstanding' => 0,
    ];

    foreach ($rows as $row) {
        $shaped = talentis_shape_candidate($row, $schedules[(int)$row['id']] ?? [], $settings);
        $candidates[] = $shaped;

        $summary['total']++;
        $summary[$shaped['status']] = ($summary[$shaped['status']] ?? 0) + 1;
        $summary['registrationCollected'] += $shaped['registrationCollected'];
        $summary['placementCollected']    += $shaped['paid'];
        $summary['outstanding']           += $shaped['pending'];
    }

    talentis_ok([
        'candidates' => $candidates,
        'summary'    => $summary,
        'settings'   => [
            'default_fee_bp'      => $settings['default_fee_bp'],
            'default_fee_percent' => talentis_percent_from_bp($settings['default_fee_bp']),
            'registration_amount' => $settings['registration_amount'],
            'gst_percent'         => $settings['gst_percent'],
        ],
    ]);
}

// ---------------------------------------------------------------------------
// Save (create or update)
// ---------------------------------------------------------------------------
if ($action === 'save') {
    if (talentis_method() !== 'POST') {
        talentis_fail(405, 'method_not_allowed', 'Use POST to save.');
    }
    talentis_require_csrf();

    $body = talentis_body();
    $id   = isset($body['id']) ? (int)$body['id'] : 0;

    $name = talentis_clean_text($body['name'] ?? '', 160);
    if ($name === null) {
        talentis_fail(422, 'name_required', 'A candidate name is required.');
    }

    $status = (string)($body['status'] ?? 'training');
    if (!in_array($status, TALENTIS_STATUSES, true)) {
        $status = 'training';
    }

    $ctc = isset($body['ctc']) ? (int)$body['ctc'] : 0;
    if ($ctc < 0) {
        $ctc = 0;
    }
    if ($ctc > 1000000000) {
        talentis_fail(422, 'ctc_too_large',
            'That CTC looks wrong. Enter the annual figure in rupees, digits only.');
    }

    // The rate. A client may send feeBp (basis points) or feePercent. Absent
    // both, a new candidate inherits the current default and an existing one
    // keeps whatever it already had.
    $bp = null;
    if (array_key_exists('feeBp', $body) && is_numeric($body['feeBp'])) {
        $bp = talentis_clean_bp($body['feeBp']);
    } elseif (array_key_exists('feePercent', $body) && is_numeric($body['feePercent'])) {
        $bp = talentis_bp_from_percent($body['feePercent']);
    }

    $emiCount = isset($body['emiCount']) ? (int)$body['emiCount'] : 1;
    if ($emiCount < 1) {
        $emiCount = 1;
    }
    if ($emiCount > 60) {
        $emiCount = 60;
    }

    $fields = [
        'name'              => $name,
        'phone'             => talentis_clean_text($body['phone'] ?? null, 32),
        'email'             => talentis_clean_text($body['email'] ?? null, 190),
        'track'             => talentis_clean_text($body['track'] ?? null, 80),
        'status'            => $status,
        'admission_date'    => talentis_clean_date($body['admissionDate'] ?? null),
        'registration_paid' => !empty($body['registrationPaid']) ? 1 : 0,
        'registration_date' => talentis_clean_date($body['registrationDate'] ?? null),
        'employer'          => talentis_clean_text($body['employer'] ?? null, 160),
        'joining_date'      => talentis_clean_date($body['joiningDate'] ?? null),
        'first_salary_date' => talentis_clean_date($body['firstSalaryDate'] ?? null),
        'ctc'               => $ctc,
        'emi_count'         => $emiCount,
        'emi_start'         => talentis_clean_date($body['emiStart'] ?? null),
        'notes'             => talentis_clean_text($body['notes'] ?? null, 4000),
    ];

    $pdo->beginTransaction();

    try {
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT * FROM candidates WHERE id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $existing = $stmt->fetch();
            if ($existing === false) {
                $pdo->rollBack();
                talentis_fail(404, 'not_found', 'That candidate no longer exists.');
            }
            if ($bp === null) {
                $bp = talentis_clean_bp((int)$existing['fee_bp']);
            }
            $registrationAmount = (int)$existing['registration_amount'];
        } else {
            if ($bp === null) {
                $bp = (int)$settings['default_fee_bp'];
            }
            $registrationAmount = (int)$settings['registration_amount'];
        }

        // Recomputed server-side. Whatever the client thought the fee was is
        // irrelevant.
        $fee = talentis_placement_fee($ctc, $bp, (int)$settings['gst_percent']);

        $fields['fee_bp']              = $bp;
        $fields['placement_fee']       = $fee;
        $fields['registration_amount'] = $registrationAmount;

        if ($id > 0) {
            $sets = [];
            foreach (array_keys($fields) as $column) {
                $sets[] = sprintf('%s = :%s', $column, $column);
            }
            $sql = 'UPDATE candidates SET ' . implode(', ', $sets) . ' WHERE id = :id';
            $params = [];
            foreach ($fields as $column => $value) {
                $params[':' . $column] = $value;
            }
            $params[':id'] = $id;
            $pdo->prepare($sql)->execute($params);
        } else {
            $columns = array_keys($fields);
            $sql = sprintf(
                'INSERT INTO candidates (%s) VALUES (%s)',
                implode(', ', $columns),
                ':' . implode(', :', $columns)
            );
            $params = [];
            foreach ($fields as $column => $value) {
                $params[':' . $column] = $value;
            }
            $pdo->prepare($sql)->execute($params);
            $id = (int)$pdo->lastInsertId();
        }

        // Rebuild the schedule, keeping payments already recorded.
        $stmt = $pdo->prepare(
            'SELECT seq, amount, due_date, paid, paid_amount, paid_date
             FROM instalments WHERE candidate_id = :id ORDER BY seq'
        );
        $stmt->execute([':id' => $id]);
        $existingInstalments = $stmt->fetchAll();

        $startDate = $fields['emi_start'] ?? $fields['first_salary_date'];
        $schedule  = talentis_build_schedule($fee, $emiCount, $startDate, $existingInstalments);

        $pdo->prepare('DELETE FROM instalments WHERE candidate_id = :id')
            ->execute([':id' => $id]);

        if ($schedule !== []) {
            $ins = $pdo->prepare(
                'INSERT INTO instalments
                    (candidate_id, seq, amount, due_date, paid, paid_amount, paid_date)
                 VALUES (:candidate_id, :seq, :amount, :due_date, :paid, :paid_amount, :paid_date)'
            );
            foreach ($schedule as $row) {
                $ins->execute([
                    ':candidate_id' => $id,
                    ':seq'          => $row['seq'],
                    ':amount'       => $row['amount'],
                    ':due_date'     => $row['due_date'],
                    ':paid'         => $row['paid'],
                    ':paid_amount'  => $row['paid_amount'],
                    ':paid_date'    => $row['paid_date'],
                ]);
            }
        }

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    talentis_audit($pdo, $admin, 'candidate_saved', $id, sprintf(
        'ctc=%d bp=%d fee=%d emis=%d', $ctc, $bp, $fee, $emiCount
    ));

    talentis_ok(['candidate' => talentis_fetch_candidate($pdo, $id, $settings)]);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
if ($action === 'delete') {
    if (talentis_method() !== 'POST') {
        talentis_fail(405, 'method_not_allowed', 'Use POST to delete.');
    }
    talentis_require_csrf();

    $body = talentis_body();
    $id   = isset($body['id']) ? (int)$body['id'] : 0;
    if ($id <= 0) {
        talentis_fail(422, 'id_required', 'Which candidate should be deleted?');
    }

    $stmt = $pdo->prepare('SELECT name FROM candidates WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    if ($row === false) {
        talentis_fail(404, 'not_found', 'That candidate no longer exists.');
    }

    // Instalments go with them via ON DELETE CASCADE.
    $pdo->prepare('DELETE FROM candidates WHERE id = :id')->execute([':id' => $id]);

    talentis_audit($pdo, $admin, 'candidate_deleted', $id, 'name=' . $row['name']);

    talentis_ok(['deleted' => $id]);
}

talentis_fail(400, 'unknown_action', 'Unknown action. Use list, save, or delete.');
