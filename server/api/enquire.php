<?php
/**
 * Talentis API — PUBLIC callback / enquiry endpoint.
 *
 *   POST enquire.php   { kind: "candidate"|"employer", name, phone, email, ... }
 *
 * This is the only endpoint anyone on the internet can call without signing in.
 * It is what the Contact and Employers forms on mytalentis.in submit to. It can
 * only ever INSERT a new enquiry; it cannot read, list, change or delete
 * anything, and it never starts an admin session.
 *
 * Defences, in order:
 *   1. Only the public website's origins may call it (CORS allowlist).
 *   2. A hidden "website" field that people never see but bots fill in.
 *   3. Strict validation and length limits on every field.
 *   4. A per-visitor rate limit, keyed on a hash of the IP (the raw IP is never
 *      stored).
 *   5. Duplicate suppression, so a double-click or a refresh does not create
 *      two identical enquiries.
 */

declare(strict_types=1);

define('TALENTIS_PUBLIC', true);
require_once __DIR__ . '/bootstrap.php';

// ---------------------------------------------------------------------------
// 1. CORS. The public site lives on GitHub Pages, so this is a cross-origin
//    call and the browser needs explicit permission to read the answer.
// ---------------------------------------------------------------------------
$publicOrigins = $config['public_origins'] ?? [
    'https://mytalentis.in',
    'https://www.mytalentis.in',
];

$origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');

if ($origin !== '' && in_array($origin, $publicOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
}

// Browsers ask permission first with OPTIONS before a JSON POST.
if (talentis_method() === 'OPTIONS') {
    http_response_code(in_array($origin, $publicOrigins, true) ? 204 : 403);
    exit;
}

if (talentis_method() !== 'POST') {
    talentis_fail(405, 'method_not_allowed', 'Use POST to send an enquiry.');
}

// A browser always sends Origin on a cross-site POST. Its absence means a
// script or a bot, and a wrong one means another website embedding our form.
if (!in_array($origin, $publicOrigins, true)) {
    talentis_fail(403, 'bad_origin', 'Enquiries are only accepted from mytalentis.in.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trim, drop control characters, cap length. Returns null when empty. */
function enq_text($value, int $max): ?string
{
    if (!is_string($value) && !is_numeric($value)) {
        return null;
    }
    $value = (string)$value;
    // Strip ASCII control characters except newline and tab.
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $value) ?? '';
    $value = trim($value);
    if ($value === '') {
        return null;
    }

    return mb_substr($value, 0, $max);
}

/** Same as enq_text but collapses to a single line, for names and headers. */
function enq_line($value, int $max): ?string
{
    $value = enq_text($value, $max);

    return $value === null ? null : trim(preg_replace('/\s+/u', ' ', $value) ?? '');
}

function enq_reject(string $field, string $message): void
{
    talentis_json([
        'ok'      => false,
        'error'   => 'invalid',
        'field'   => $field,
        'message' => $message,
    ], 422);
}

// ---------------------------------------------------------------------------
// 2. Read and screen the submission
// ---------------------------------------------------------------------------
$body = talentis_body();

// Honeypot. A real visitor never sees this field. If it has anything in it,
// answer exactly as if it worked, so the bot learns nothing, and store nothing.
if (!empty($body['website'])) {
    talentis_ok(['message' => 'Thanks. Your request is in.']);
}

$kind = ($body['kind'] ?? '') === 'employer' ? 'employer' : 'candidate';

$name    = enq_line($body['name'] ?? null, 160);
$phone   = enq_line($body['phone'] ?? null, 32);
$email   = enq_line($body['email'] ?? null, 190);
$company = enq_line($body['company'] ?? null, 160);
$message = enq_text($body['message'] ?? ($body['detail'] ?? null), 3000);
$consent = !empty($body['consent']);

// ---------------------------------------------------------------------------
// 3. Validate. Messages are written for the visitor, not a developer.
// ---------------------------------------------------------------------------
if ($name === null || mb_strlen($name) < 2) {
    enq_reject('name', 'Please enter your name.');
}

if ($phone !== null && !preg_match('/^[0-9+()\-\s]{8,18}$/', $phone)) {
    enq_reject('phone', 'Enter a valid phone number, digits only.');
}

if ($email !== null && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    enq_reject('email', 'Enter a valid email address.');
}

if ($phone === null && $email === null) {
    enq_reject('phone', 'Give us a phone number or an email so we can reach you.');
}

if ($kind === 'candidate' && $phone === null) {
    enq_reject('phone', 'Please add a phone number so a counsellor can call you back.');
}

if ($kind === 'employer' && $company === null) {
    enq_reject('company', 'Please enter your company name.');
}

if (!$consent) {
    enq_reject('consent', 'Please tick the consent box so we can contact you.');
}

// Links are the calling card of spam. Real enquiries rarely contain more than
// one, and the forms ask about background, not URLs.
if ($message !== null && preg_match_all('~https?://~i', $message) > 2) {
    enq_reject('message', 'Please remove the links and describe your background instead.');
}

$fields = [
    'kind'           => $kind,
    'name'           => $name,
    'phone'          => $phone,
    'email'          => $email,
    'company'        => $kind === 'employer' ? $company : null,
    'track'          => $kind === 'candidate' ? enq_line($body['track'] ?? null, 80) : null,
    'current_status' => $kind === 'candidate' ? enq_line($body['status'] ?? null, 80) : null,
    'batch_format'   => $kind === 'candidate' ? enq_line($body['format'] ?? null, 40) : null,
    'hiring_model'   => $kind === 'employer' ? enq_line($body['model'] ?? null, 80) : null,
    'positions'      => $kind === 'employer' ? enq_line($body['count'] ?? null, 20) : null,
    'message'        => $message,
    'consent'        => 1,
    'source_page'    => enq_line($body['page'] ?? null, 120),
];

// ---------------------------------------------------------------------------
// 4. Rate limit, keyed on a salted hash of the visitor's IP.
// ---------------------------------------------------------------------------
$ip   = (string)($_SERVER['REMOTE_ADDR'] ?? '');
$salt = (string)($config['enquiry_salt'] ?? '');
if ($salt === '') {
    // No dedicated salt configured: derive a stable secret from the database
    // credentials, which are private to this server.
    $salt = hash('sha256', 'talentis-enquiry|' . ($config['db']['password'] ?? '') . '|' . ($config['db']['name'] ?? ''));
}
$ipHash = hash_hmac('sha256', $ip, $salt);

$limitStmt = $pdo->prepare(
    'SELECT
        SUM(created_at >= (NOW() - INTERVAL 1 HOUR)) AS last_hour,
        COUNT(*)                                    AS last_day
     FROM enquiries
     WHERE ip_hash = :ip AND created_at >= (NOW() - INTERVAL 1 DAY)'
);
$limitStmt->execute([':ip' => $ipHash]);
$usage = $limitStmt->fetch() ?: ['last_hour' => 0, 'last_day' => 0];

if ((int)$usage['last_hour'] >= 5 || (int)$usage['last_day'] >= 20) {
    talentis_json([
        'ok'      => false,
        'error'   => 'rate_limited',
        'message' => 'We have already received several requests from you. Our team will be in touch, or call us directly.',
    ], 429);
}

// ---------------------------------------------------------------------------
// 5. Duplicate suppression: same person, same form, within ten minutes.
// ---------------------------------------------------------------------------
$dupStmt = $pdo->prepare(
    'SELECT id FROM enquiries
     WHERE kind = :kind
       AND created_at >= (NOW() - INTERVAL 10 MINUTE)
       AND ((:phone1 IS NOT NULL AND phone = :phone2)
         OR (:email1 IS NOT NULL AND email = :email2))
     LIMIT 1'
);
$dupStmt->execute([
    ':kind'   => $kind,
    ':phone1' => $phone,
    ':phone2' => $phone,
    ':email1' => $email,
    ':email2' => $email,
]);

if ($dupStmt->fetch() !== false) {
    talentis_ok([
        'message'   => 'Thanks. We already have your request and will be in touch shortly.',
        'duplicate' => true,
    ]);
}

// ---------------------------------------------------------------------------
// 6. Store it.
// ---------------------------------------------------------------------------
$fields['ip_hash']    = $ipHash;
$fields['user_agent'] = enq_line($_SERVER['HTTP_USER_AGENT'] ?? null, 255);

$columns = array_keys($fields);
$insert  = $pdo->prepare(sprintf(
    'INSERT INTO enquiries (%s) VALUES (%s)',
    implode(', ', $columns),
    ':' . implode(', :', $columns)
));
$params = [];
foreach ($fields as $column => $value) {
    $params[':' . $column] = $value;
}
$insert->execute($params);
$enquiryId = (int)$pdo->lastInsertId();

// ---------------------------------------------------------------------------
// 7. Optional email alert. Never allowed to break the submission: the enquiry
//    is already safely stored, and the dashboard shows it either way.
// ---------------------------------------------------------------------------
// Alerts go to the one company mailbox unless config.php says otherwise.
$notifyTo = trim((string)($config['notify_email'] ?? 'hello@mytalentis.in'));

if ($notifyTo !== '' && filter_var($notifyTo, FILTER_VALIDATE_EMAIL)) {
    try {
        // Send from the real mailbox. Hostinger rejects or spam-folders mail
        // "from" an address that does not exist on the domain.
        $from = (string)($config['mail_from'] ?? 'hello@mytalentis.in');
        if (!filter_var($from, FILTER_VALIDATE_EMAIL)) {
            $from = 'hello@mytalentis.in';
        }

        // Header values must be single-line to rule out header injection.
        $safe = static fn(?string $v): string => $v === null ? '-' : str_replace(["\r", "\n"], ' ', $v);

        $subject = ($kind === 'employer' ? 'New hiring request: ' : 'New callback request: ')
            . mb_substr($safe($name), 0, 80);

        $lines = [
            'A new ' . ($kind === 'employer' ? 'hiring requirement' : 'callback request')
                . ' has arrived on mytalentis.in.',
            '',
            'Name:    ' . $safe($name),
            'Phone:   ' . $safe($phone),
            'Email:   ' . $safe($email),
        ];
        if ($kind === 'employer') {
            $lines[] = 'Company: ' . $safe($company);
            $lines[] = 'Model:   ' . $safe($fields['hiring_model']);
            $lines[] = 'Roles:   ' . $safe($fields['positions']);
        } else {
            $lines[] = 'Track:   ' . $safe($fields['track']);
            $lines[] = 'Status:  ' . $safe($fields['current_status']);
            $lines[] = 'Format:  ' . $safe($fields['batch_format']);
        }
        $lines[] = '';
        $lines[] = 'Message:';
        $lines[] = $message ?? '-';
        $lines[] = '';
        $lines[] = 'Open it in the dashboard: https://admin.mytalentis.in/admin.html#enquiries';
        $lines[] = 'Reference: enquiry #' . $enquiryId;

        $headers = implode("\r\n", [
            'From: Talentis Website <' . $from . '>',
            'Content-Type: text/plain; charset=UTF-8',
            'X-Auto-Response-Suppress: All',
        ]);

        if ($email !== null) {
            $headers .= "\r\nReply-To: " . $safe($email);
        }

        mail($notifyTo, '=?UTF-8?B?' . base64_encode($subject) . '?=', implode("\n", $lines), $headers);
    } catch (Throwable $e) {
        // Swallowed on purpose. See the comment above step 7.
    }
}

talentis_ok([
    'message' => $kind === 'employer'
        ? 'Thanks. Your requirement is in, and a recruiter will contact you within one working day.'
        : 'Thanks. Your request is in, and a counsellor will call you within one working day.',
]);
