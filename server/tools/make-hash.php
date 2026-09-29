<?php
/**
 * Talentis — create the SQL to add an admin account.
 *
 * Run this from the command line, NOT through a browser. It is deliberately not
 * an endpoint: a page on the internet that mints admin accounts is a back door,
 * however well intentioned.
 *
 * Hostinger gives you SSH on most plans (hPanel -> Advanced -> SSH Access):
 *
 *     php tools/make-hash.php 'you@yourdomain.in' 'the-password-you-chose'
 *
 * It prints an INSERT statement. Paste that into phpMyAdmin, then delete this
 * file from the server. Your password is never stored anywhere; only the bcrypt
 * hash goes into the database, and a hash cannot be reversed.
 *
 * No SSH? Run it on your own Mac if PHP is installed, or ask and I will hash a
 * password for you locally. Do not paste the password into a chat window.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "This tool only runs from the command line.\n";
    echo "Delete this file from the server once you have created your account.\n";
    exit;
}

$email    = $argv[1] ?? '';
$password = $argv[2] ?? '';
$name     = $argv[3] ?? '';

if ($email === '' || $password === '') {
    fwrite(STDERR, "Usage: php tools/make-hash.php 'email' 'password' ['Full Name']\n");
    exit(1);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "That does not look like a valid email address.\n");
    exit(1);
}

// Basic sanity on the password. Nothing here is enforced by the API, but a
// weak admin password on a system holding salary data is worth objecting to.
$problems = [];
if (strlen($password) < 12) {
    $problems[] = 'shorter than 12 characters';
}
if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/[0-9]/', $password)) {
    $problems[] = 'no mix of letters and digits';
}
if (preg_match('/^(password|admin|talentis|123456)/i', $password)) {
    $problems[] = 'starts with something guessable';
}

if ($problems !== []) {
    fwrite(STDERR, "\nWARNING: this password is " . implode(', ', $problems) . ".\n");
    fwrite(STDERR, "It guards candidate salary and payment records. Consider a stronger one.\n\n");
}

$hash = password_hash($password, PASSWORD_DEFAULT);
if ($hash === false) {
    fwrite(STDERR, "Hashing failed. Is the PHP password extension available?\n");
    exit(1);
}

$quote = static fn(string $value): string => "'" . str_replace("'", "''", $value) . "'";

echo "\n-- Paste this into phpMyAdmin -> SQL, then delete tools/make-hash.php\n";
echo "INSERT INTO admins (email, password_hash, full_name, is_active)\n";
echo 'VALUES (' . $quote($email) . ', ' . $quote($hash) . ', '
    . ($name === '' ? 'NULL' : $quote($name)) . ", 1)\n";
echo "ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),\n";
echo "                        full_name     = VALUES(full_name),\n";
echo "                        is_active     = 1,\n";
echo "                        failed_attempts = 0,\n";
echo "                        locked_until  = NULL;\n\n";
echo "-- Re-running this for an existing email resets that account's password.\n\n";
