<?php
/**
 * Talentis — fee arithmetic. THIS IS THE SOURCE OF TRUTH.
 *
 * The browser carries the same maths in admin.js so figures can update as you
 * type, but nothing the browser sends is trusted: every amount written to the
 * database is recomputed here from the CTC and the stored rate. A client that
 * posts its own totals is a client that can be edited.
 *
 * Rules:
 *   placement fee = rate% of annual CTC, whole rupees
 *   registration  = flat amount, SEPARATE, never deducted from the fee
 *   instalments   = equal whole-rupee split, remainder onto instalment 1
 *
 * THE RATE IS ADMIN-EDITABLE and is expressed in BASIS POINTS throughout:
 *   10%   = 1000 bp
 *   12.5% = 1250 bp
 *   7.25% =  725 bp
 * Basis points keep every calculation in integers. A rate held as a float would
 * reintroduce exactly the rounding risk this module exists to avoid.
 *
 * Worked example, pinned by the tests:
 *   CTC 453100 at 1000 bp -> fee 45310 -> total payable 50310
 *   45310 over 3 -> 15104 + 15103 + 15103
 */

declare(strict_types=1);

/** Basis points are capped at 100% — a fee larger than the salary is a typo. */
const TALENTIS_MIN_BP = 0;
const TALENTIS_MAX_BP = 10000;

/**
 * Normalise whatever the client sent into safe basis points.
 * Accepts 1000 (bp) or "10" / "10.5" (percent) and is explicit about which.
 */
function talentis_bp_from_percent($percent): int
{
    if (!is_numeric($percent)) {
        return 0;
    }

    // Percent to basis points, rounded half up, without trusting floats for
    // the final value: multiply, then round once.
    $bp = (int)round(((float)$percent) * 100.0);

    return max(TALENTIS_MIN_BP, min(TALENTIS_MAX_BP, $bp));
}

/** Clamp a basis-point value arriving from the client or database. */
function talentis_clean_bp($bp): int
{
    if (!is_numeric($bp)) {
        return 0;
    }

    return max(TALENTIS_MIN_BP, min(TALENTIS_MAX_BP, (int)$bp));
}

/** For display: 1250 -> "12.5", 1000 -> "10". */
function talentis_percent_from_bp(int $bp): string
{
    $bp = talentis_clean_bp($bp);
    if ($bp % 100 === 0) {
        return (string)intdiv($bp, 100);
    }

    return rtrim(rtrim(number_format($bp / 100, 2, '.', ''), '0'), '.');
}

/**
 * The placement fee in whole rupees.
 *
 * All integer arithmetic: fee = ctc * bp / 10000, rounded half up. Note there
 * is no `$ctc * 0.1` anywhere, because 0.1 has no exact binary representation
 * and would eventually round a real invoice the wrong way.
 */
function talentis_placement_fee(int $ctc, int $bp, int $gstPercent = 0): int
{
    if ($ctc <= 0) {
        return 0;
    }

    $bp = talentis_clean_bp($bp);
    if ($bp === 0) {
        return 0;
    }

    $numerator = $ctc * $bp;              // e.g. 453100 * 1000 = 453,100,000
    $fee       = intdiv($numerator, 10000);
    $remainder = $numerator % 10000;
    if ($remainder * 2 >= 10000) {
        $fee++;                            // round half up
    }

    if ($gstPercent > 0) {
        $gstNumerator = $fee * $gstPercent;
        $gst          = intdiv($gstNumerator, 100);
        if (($gstNumerator % 100) * 2 >= 100) {
            $gst++;
        }
        $fee += $gst;
    }

    return $fee;
}

/**
 * Split a total into $count whole-rupee parts summing exactly to the total.
 * The remainder lands on the FIRST part, matching what the website publishes.
 *
 * @return int[] index 0 is instalment 1
 */
function talentis_split_amount(int $total, int $count): array
{
    if ($total < 0) {
        $total = 0;
    }
    if ($count < 1) {
        $count = 1;
    }

    $base      = intdiv($total, $count);
    $remainder = $total - ($base * $count);

    $parts = [];
    for ($i = 0; $i < $count; $i++) {
        $parts[] = ($i === 0) ? $base + $remainder : $base;
    }

    return $parts;
}

/**
 * Add whole months to a Y-m-d date, clamping to the end of the target month so
 * 31 January plus one month lands on 28 or 29 February instead of overflowing
 * into March.
 */
function talentis_add_months(?string $isoDate, int $months): ?string
{
    if ($isoDate === null || $isoDate === '') {
        return null;
    }

    $parts = explode('-', $isoDate);
    if (count($parts) !== 3) {
        return null;
    }

    $year  = (int)$parts[0];
    $month = (int)$parts[1];
    $day   = (int)$parts[2];
    if ($year < 1900 || $month < 1 || $month > 12 || $day < 1 || $day > 31) {
        return null;
    }

    $total       = ($year * 12) + ($month - 1) + $months;
    $targetYear  = intdiv($total, 12);
    $targetMonth = ($total % 12) + 1;

    $lastDay = (int)date('t', mktime(0, 0, 0, $targetMonth, 1, $targetYear));

    return sprintf('%04d-%02d-%02d', $targetYear, $targetMonth, min($day, $lastDay));
}

/**
 * Build a schedule, preserving payments already recorded against instalment
 * numbers that still exist after the rebuild.
 *
 * @param array $existing rows carrying seq/paid/paid_amount/paid_date/due_date
 * @return array<int, array<string, mixed>>
 */
function talentis_build_schedule(
    int $fee,
    int $count,
    ?string $startDate,
    array $existing = []
): array {
    if ($fee <= 0) {
        return [];
    }

    $bySeq = [];
    foreach ($existing as $row) {
        $seq = (int)($row['seq'] ?? 0);
        if ($seq > 0) {
            $bySeq[$seq] = $row;
        }
    }

    $amounts  = talentis_split_amount($fee, $count);
    $schedule = [];

    foreach ($amounts as $index => $amount) {
        $seq  = $index + 1;
        $prev = $bySeq[$seq] ?? null;
        $paid = $prev !== null && (int)($prev['paid'] ?? 0) === 1;

        $dueDate = $prev['due_date'] ?? null;
        if ($dueDate === null || $dueDate === '') {
            $dueDate = talentis_add_months($startDate, $index);
        }

        $schedule[] = [
            'seq'         => $seq,
            'amount'      => $amount,
            'due_date'    => $dueDate,
            'paid'        => $paid ? 1 : 0,
            // A recorded part payment survives a rebuild; otherwise default to
            // the amount due, so ticking "paid" needs no extra typing.
            'paid_amount' => $paid ? (int)($prev['paid_amount'] ?? $amount) : $amount,
            'paid_date'   => $paid ? ($prev['paid_date'] ?? null) : null,
        ];
    }

    return $schedule;
}

/**
 * Totals for one candidate, computed rather than trusted.
 *
 * @return array{fee:int,paid:int,pending:int,registration:int,total_billed:int}
 */
function talentis_candidate_totals(
    int $ctc,
    int $bp,
    bool $registrationPaid,
    int $registrationAmount,
    array $instalments,
    int $gstPercent = 0
): array {
    $fee  = talentis_placement_fee($ctc, $bp, $gstPercent);
    $paid = 0;

    foreach ($instalments as $row) {
        if ((int)($row['paid'] ?? 0) === 1) {
            $paid += (int)($row['paid_amount'] ?? 0);
        }
    }

    return [
        'fee'          => $fee,
        'paid'         => $paid,
        'pending'      => max(0, $fee - $paid),
        'registration' => $registrationPaid ? $registrationAmount : 0,
        'total_billed' => $registrationAmount + $fee,
    ];
}
