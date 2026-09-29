<?php
/**
 * Talentis API — recording payments against instalments.
 *
 *   POST payments.php?action=save
 *   { "candidateId": 12,
 *     "instalments": [ { "n":1, "paid":true, "paidAmount":15104,
 *                        "paidDate":"2026-10-05", "dueDate":"2026-10-01" } ] }
 *
 * Only the payment columns are writable here. The amount DUE is never taken
 * from the client: it is recomputed from the candidate's ctc and rate, so the
 * schedule cannot be quietly rewritten through this endpoint.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

$admin    = talentis_require_admin();
$settings = talentis_settings($pdo);
$action   = talentis_action();

if ($action !== 'save') {
    talentis_fail(400, 'unknown_action', 'Unknown action. Use save.');
}

if (talentis_method() !== 'POST') {
    talentis_fail(405, 'method_not_allowed', 'Use POST to record payments.');
}
talentis_require_csrf();

$body        = talentis_body();
$candidateId = isset($body['candidateId']) ? (int)$body['candidateId'] : 0;
$incoming    = $body['instalments'] ?? [];

if ($candidateId <= 0) {
    talentis_fail(422, 'id_required', 'Which candidate are these payments for?');
}
if (!is_array($incoming)) {
    talentis_fail(422, 'bad_payload', 'instalments must be a list.');
}

$stmt = $pdo->prepare('SELECT * FROM candidates WHERE id = :id LIMIT 1');
$stmt->execute([':id' => $candidateId]);
$candidate = $stmt->fetch();
if ($candidate === false) {
    talentis_fail(404, 'not_found', 'That candidate no longer exists.');
}

// The authoritative amounts, derived not accepted.
$ctc = (int)$candidate['ctc'];
$bp  = talentis_clean_bp((int)$candidate['fee_bp']);
$fee = talentis_placement_fee($ctc, $bp, (int)$settings['gst_percent']);

$stmt = $pdo->prepare(
    'SELECT seq, amount FROM instalments WHERE candidate_id = :id ORDER BY seq'
);
$stmt->execute([':id' => $candidateId]);
$known = [];
foreach ($stmt->fetchAll() as $row) {
    $known[(int)$row['seq']] = (int)$row['amount'];
}

if ($known === []) {
    talentis_fail(409, 'no_schedule',
        'This candidate has no instalment schedule yet. Set a CTC first.');
}

$pdo->beginTransaction();

try {
    $update = $pdo->prepare(
        'UPDATE instalments
         SET paid = :paid, paid_amount = :paid_amount,
             paid_date = :paid_date, due_date = :due_date
         WHERE candidate_id = :candidate_id AND seq = :seq'
    );

    $touched = 0;

    foreach ($incoming as $row) {
        if (!is_array($row)) {
            continue;
        }

        $seq = (int)($row['n'] ?? $row['seq'] ?? 0);
        if ($seq <= 0 || !array_key_exists($seq, $known)) {
            // Silently skip anything referring to an instalment that does not
            // exist, rather than inventing one.
            continue;
        }

        $paid = !empty($row['paid']) ? 1 : 0;
        $due  = $known[$seq];

        if ($paid === 1) {
            $amount = isset($row['paidAmount']) ? (int)$row['paidAmount'] : $due;
            if ($amount < 0) {
                $amount = 0;
            }
            // A single instalment cannot record more than the whole fee. Guards
            // against a stray extra digit turning 15,104 into 151,040.
            if ($amount > $fee) {
                $pdo->rollBack();
                talentis_fail(422, 'amount_too_large', sprintf(
                    'Instalment %d records more than the full fee of %d. Check the amount.',
                    $seq,
                    $fee
                ));
            }
            $paidDate = talentis_payment_date($row['paidDate'] ?? null);
        } else {
            $amount   = $due;
            $paidDate = null;
        }

        $update->execute([
            ':paid'         => $paid,
            ':paid_amount'  => $amount,
            ':paid_date'    => $paidDate,
            ':due_date'     => talentis_payment_date($row['dueDate'] ?? null),
            ':candidate_id' => $candidateId,
            ':seq'          => $seq,
        ]);
        $touched++;
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    throw $e;
}

// Re-read so the client gets figures straight from the database.
$stmt = $pdo->prepare(
    'SELECT seq, amount, due_date, paid, paid_amount, paid_date
     FROM instalments WHERE candidate_id = :id ORDER BY seq'
);
$stmt->execute([':id' => $candidateId]);
$instalments = $stmt->fetchAll();

$totals = talentis_candidate_totals(
    $ctc,
    $bp,
    (int)$candidate['registration_paid'] === 1,
    (int)$candidate['registration_amount'],
    $instalments,
    (int)$settings['gst_percent']
);

talentis_audit($pdo, $admin, 'payments_saved', $candidateId, sprintf(
    'rows=%d paid=%d pending=%d', $touched, $totals['paid'], $totals['pending']
));

talentis_ok([
    'candidateId' => $candidateId,
    'totals'      => [
        'fee'     => $totals['fee'],
        'paid'    => $totals['paid'],
        'pending' => $totals['pending'],
    ],
    'emis' => array_map(static function (array $i): array {
        return [
            'n'          => (int)$i['seq'],
            'amount'     => (int)$i['amount'],
            'dueDate'    => $i['due_date'],
            'paid'       => (int)$i['paid'] === 1,
            'paidAmount' => (int)$i['paid_amount'],
            'paidDate'   => $i['paid_date'],
        ];
    }, $instalments),
]);

/**
 * Accept a Y-m-d date or nothing. Defined at the end because PHP hoists
 * function declarations in the top-level scope of a file.
 */
function talentis_payment_date($value): ?string
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
