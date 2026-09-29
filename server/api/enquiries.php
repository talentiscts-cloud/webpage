<?php
/**
 * Talentis API — enquiry inbox (admin only).
 *
 *   GET  enquiries.php                  -> every enquiry, newest first, + counts
 *   POST enquiries.php?action=update    -> { id, status, notes }
 *   POST enquiries.php?action=admit     -> { id, registrationPaid, registrationDate }
 *   POST enquiries.php?action=delete    -> { id }
 *
 * "Admit" turns a candidate enquiry into a real candidate record, copying the
 * name, phone, email and track across, and links the two so the enquiry shows
 * who it became. It is transactional and idempotent: admitting the same
 * enquiry twice returns the candidate already created instead of a duplicate.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

$admin    = talentis_require_admin();
$settings = talentis_settings($pdo);
$action   = talentis_action();

const ENQ_STATUSES = ['new', 'contacted', 'admitted', 'not_interested', 'spam'];

/**
 * The public form's track labels are written for visitors ("Full-Stack Java
 * Development", "Compliance-Based Training (best seller)"). The dashboard uses
 * shorter names. Map one to the other so an admitted candidate lands with the
 * right track already selected.
 */
function enq_map_track(?string $label): ?string
{
    if ($label === null || $label === '') {
        return null;
    }

    $l = strtolower($label);
    $map = [
        'compliance' => 'Compliance-Based Training',
        'java'       => 'Full-Stack Java',
        'data'       => 'Data Engineering',
        'cloud'      => 'Cloud & DevOps',
        'devops'     => 'Cloud & DevOps',
        'qa'         => 'QA Automation',
        'test'       => 'QA Automation',
        'business'   => 'Business Analysis',
    ];
    foreach ($map as $needle => $track) {
        if (strpos($l, $needle) !== false) {
            return $track;
        }
    }

    // "Not sure, recommend one for me" and anything unrecognised.
    return null;
}

function enq_shape(array $r): array
{
    return [
        'id'            => (int)$r['id'],
        'kind'          => (string)$r['kind'],
        'name'          => (string)$r['name'],
        'phone'         => $r['phone'],
        'email'         => $r['email'],
        'company'       => $r['company'],
        'track'         => $r['track'],
        'currentStatus' => $r['current_status'],
        'batchFormat'   => $r['batch_format'],
        'hiringModel'   => $r['hiring_model'],
        'positions'     => $r['positions'],
        'message'       => $r['message'],
        'sourcePage'    => $r['source_page'],
        'status'        => (string)$r['status'],
        'notes'         => $r['admin_notes'],
        'contactedAt'   => $r['contacted_at'],
        'candidateId'   => $r['candidate_id'] !== null ? (int)$r['candidate_id'] : null,
        'createdAt'     => $r['created_at'],
        'updatedAt'     => $r['updated_at'],
    ];
}

function enq_fetch(PDO $pdo, int $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM enquiries WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();

    return $row === false ? null : enq_shape($row);
}

function enq_id_from_body(): int
{
    $body = talentis_body();
    $id   = isset($body['id']) ? (int)$body['id'] : 0;
    if ($id <= 0) {
        talentis_fail(422, 'id_required', 'Which enquiry?');
    }

    return $id;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
if ($action === '' || $action === 'list') {
    try {
        $rows = $pdo->query(
            'SELECT * FROM enquiries ORDER BY created_at DESC, id DESC LIMIT 1000'
        )->fetchAll();
    } catch (PDOException $e) {
        // The single most likely setup mistake: the migration was never run.
        talentis_fail(500, 'enquiries_table_missing',
            'The enquiries table does not exist yet. Run migrations/002_enquiries.sql in phpMyAdmin.',
            $e->getMessage());
    }

    $counts = array_fill_keys(ENQ_STATUSES, 0);
    foreach ($rows as $row) {
        $counts[(string)$row['status']] = ($counts[(string)$row['status']] ?? 0) + 1;
    }

    talentis_ok([
        'enquiries' => array_map('enq_shape', $rows),
        'counts'    => $counts,
    ]);
}

// Everything below changes data.
if (talentis_method() !== 'POST') {
    talentis_fail(405, 'method_not_allowed', 'Use POST.');
}
talentis_require_csrf();

// ---------------------------------------------------------------------------
// Update status and notes
// ---------------------------------------------------------------------------
if ($action === 'update') {
    $id   = enq_id_from_body();
    $body = talentis_body();

    $existing = enq_fetch($pdo, $id);
    if ($existing === null) {
        talentis_fail(404, 'not_found', 'That enquiry no longer exists.');
    }

    $status = (string)($body['status'] ?? $existing['status']);
    if (!in_array($status, ENQ_STATUSES, true)) {
        talentis_fail(422, 'bad_status', 'Unknown status.');
    }
    // "Admitted" is only reachable through the admit action, which creates the
    // candidate. Setting it by hand would leave an enquiry that claims a
    // candidate exists when none does.
    if ($status === 'admitted' && $existing['candidateId'] === null) {
        talentis_fail(422, 'use_admit', 'Use "Admit as candidate" to admit someone.');
    }

    $notes = $body['notes'] ?? $existing['notes'];
    $notes = is_string($notes) ? mb_substr(trim($notes), 0, 4000) : null;
    if ($notes === '') {
        $notes = null;
    }

    $stmt = $pdo->prepare(
        'UPDATE enquiries
         SET status = :status,
             admin_notes = :notes,
             contacted_at = CASE
                 WHEN :status2 = \'contacted\' AND contacted_at IS NULL THEN NOW()
                 ELSE contacted_at
             END
         WHERE id = :id'
    );
    $stmt->execute([
        ':status'  => $status,
        ':status2' => $status,
        ':notes'   => $notes,
        ':id'      => $id,
    ]);

    if ($status !== $existing['status']) {
        talentis_audit($pdo, $admin, 'enquiry_status', $existing['candidateId'],
            sprintf('enquiry=%d %s->%s', $id, $existing['status'], $status));
    }

    talentis_ok(['enquiry' => enq_fetch($pdo, $id)]);
}

// ---------------------------------------------------------------------------
// Admit: enquiry -> candidate
// ---------------------------------------------------------------------------
if ($action === 'admit') {
    $id   = enq_id_from_body();
    $body = talentis_body();

    $pdo->beginTransaction();

    try {
        // Lock the row so two admins clicking Admit at once cannot create two
        // candidates from one enquiry.
        $stmt = $pdo->prepare('SELECT * FROM enquiries WHERE id = :id LIMIT 1 FOR UPDATE');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();

        if ($row === false) {
            $pdo->rollBack();
            talentis_fail(404, 'not_found', 'That enquiry no longer exists.');
        }

        if ($row['kind'] !== 'candidate') {
            $pdo->rollBack();
            talentis_fail(422, 'not_a_candidate',
                'This is a hiring request from an employer, not a candidate enquiry.');
        }

        // Already admitted, and the candidate still exists: hand it back.
        if ($row['candidate_id'] !== null) {
            $check = $pdo->prepare('SELECT id FROM candidates WHERE id = :cid LIMIT 1');
            $check->execute([':cid' => (int)$row['candidate_id']]);
            if ($check->fetch() !== false) {
                $pdo->commit();
                talentis_ok([
                    'candidateId'     => (int)$row['candidate_id'],
                    'alreadyAdmitted' => true,
                    'enquiry'         => enq_fetch($pdo, $id),
                ]);
            }
        }

        $registrationPaid = !empty($body['registrationPaid']) ? 1 : 0;
        $registrationDate = null;
        if ($registrationPaid && is_string($body['registrationDate'] ?? null)) {
            $parts = explode('-', (string)$body['registrationDate']);
            if (count($parts) === 3 && checkdate((int)$parts[1], (int)$parts[2], (int)$parts[0])) {
                $registrationDate = sprintf('%04d-%02d-%02d', (int)$parts[0], (int)$parts[1], (int)$parts[2]);
            }
        }
        if ($registrationPaid && $registrationDate === null) {
            $registrationDate = date('Y-m-d');
        }

        // Carry the enquiry's context into the candidate's notes, so whoever
        // opens the record later can see why this person came to us.
        $noteLines = ['Admitted from website enquiry #' . $id . ' received ' . $row['created_at'] . '.'];
        if (!empty($row['current_status'])) {
            $noteLines[] = 'Current status: ' . $row['current_status'];
        }
        if (!empty($row['batch_format'])) {
            $noteLines[] = 'Preferred batch: ' . $row['batch_format'];
        }
        if (!empty($row['message'])) {
            $noteLines[] = 'Background: ' . $row['message'];
        }
        if (!empty($row['admin_notes'])) {
            $noteLines[] = 'Enquiry notes: ' . $row['admin_notes'];
        }

        $insert = $pdo->prepare(
            'INSERT INTO candidates
                (name, phone, email, track, status, admission_date,
                 registration_amount, registration_paid, registration_date,
                 ctc, fee_bp, placement_fee, emi_count, notes)
             VALUES
                (:name, :phone, :email, :track, \'training\', :admission_date,
                 :registration_amount, :registration_paid, :registration_date,
                 0, :fee_bp, 0, 1, :notes)'
        );
        $insert->execute([
            ':name'                => $row['name'],
            ':phone'               => $row['phone'],
            ':email'               => $row['email'],
            ':track'               => enq_map_track($row['track']),
            ':admission_date'      => date('Y-m-d'),
            ':registration_amount' => (int)$settings['registration_amount'],
            ':registration_paid'   => $registrationPaid,
            ':registration_date'   => $registrationDate,
            ':fee_bp'              => (int)$settings['default_fee_bp'],
            ':notes'               => mb_substr(implode("\n", $noteLines), 0, 4000),
        ]);
        $candidateId = (int)$pdo->lastInsertId();

        $pdo->prepare(
            'UPDATE enquiries
             SET status = \'admitted\', candidate_id = :cid,
                 contacted_at = COALESCE(contacted_at, NOW())
             WHERE id = :id'
        )->execute([':cid' => $candidateId, ':id' => $id]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    talentis_audit($pdo, $admin, 'enquiry_admitted', $candidateId,
        sprintf('enquiry=%d registration_paid=%d', $id, $registrationPaid));

    talentis_ok([
        'candidateId'     => $candidateId,
        'alreadyAdmitted' => false,
        'enquiry'         => enq_fetch($pdo, $id),
    ]);
}

// ---------------------------------------------------------------------------
// Delete (for spam and test submissions)
// ---------------------------------------------------------------------------
if ($action === 'delete') {
    $id = enq_id_from_body();

    $existing = enq_fetch($pdo, $id);
    if ($existing === null) {
        talentis_fail(404, 'not_found', 'That enquiry no longer exists.');
    }

    // Deleting the enquiry never touches an admitted candidate.
    $pdo->prepare('DELETE FROM enquiries WHERE id = :id')->execute([':id' => $id]);

    talentis_audit($pdo, $admin, 'enquiry_deleted', $existing['candidateId'],
        sprintf('enquiry=%d name=%s', $id, $existing['name']));

    talentis_ok(['deleted' => $id]);
}

talentis_fail(400, 'unknown_action', 'Unknown action. Use list, update, admit, or delete.');
