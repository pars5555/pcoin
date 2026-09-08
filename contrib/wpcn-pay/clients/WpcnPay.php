<?php
declare(strict_types=1);

/**
 * Drop-in client for the shared wPCN payment verifier.
 *
 *   $wpcn = new WpcnPay(WPCN_PAY_TOKEN);
 *   $r = $wpcn->verify($txhash, (string) $user->id);
 *   if ($r['state'] === 'credited') { ...credit $r['usd_total']... }
 *
 * The verifier owns the anti-double-credit ledger, so a project never has to
 * decide whether a hash has been claimed before -- it asks, and the answer is
 * authoritative across all four projects. What a project still owns is its own
 * user balance and its own idempotency, because a lost response on YOUR side
 * must not credit twice either.
 *
 * WHAT THIS CLASS EXISTS TO STOP
 * Every failure mode below has cost this project money at least once, on the
 * PCN rails, in almost exactly this shape:
 *
 *   * A transport failure read as "no payment". curl_exec() returning false is
 *     not an answer; it is the absence of one. Everything here that cannot be
 *     resolved comes back as `unreadable`, never as a definite state.
 *   * `?? 0`, `@`-suppression and `(int)` on a failed call. There is not one of
 *     those in this file on a value that decides money.
 *   * A rate re-derived at display time instead of the one actually credited.
 *     `rate_usd` comes back on the row and MUST be stored with the credit.
 */
final class WpcnPay
{
    /** Every state the verifier can return, and whether it means "money arrived". */
    public const CREDITED        = 'credited';         // credit usd_total, once
    public const ALREADY_CLAIMED = 'already_claimed';  // credit NOTHING
    public const PENDING         = 'pending';          // not on chain yet; retry
    public const CONFIRMING      = 'confirming';       // seen, too shallow; retry
    public const NO_PAYMENT      = 'no_payment';       // real tx, paid us nothing
    public const REVERTED        = 'reverted';         // failed on chain
    public const REORGED         = 'reorged';          // block no longer canonical
    public const BAD_REQUEST     = 'bad_request';      // malformed hash
    public const UNREADABLE      = 'unreadable';       // WE COULD NOT LOOK. Retry.

    public function __construct(
        private string $token,
        private string $endpoint = 'https://wpcnpay.pc.am',
        private int $timeoutS = 60,
    ) {}

    /**
     * Ask whether $txhash paid us, and claim it for $userRef.
     *
     * Returns an array that ALWAYS has a 'state'. It never throws: a caller that
     * has to wrap this in try/catch will eventually forget to, and the catch
     * block is where "unknown" turns into "no".
     */
    public function verify(string $txhash, string $userRef): array
    {
        return $this->post('/verify', ['txhash' => $txhash, 'user_ref' => $userRef]);
    }

    /** Every claim banked to this project for one user. Read-only. */
    public function claims(string $userRef): array
    {
        return $this->get('/claims?user_ref=' . rawurlencode($userRef));
    }

    /**
     * True only for a definite "this paid us and it is yours now".
     * Deliberately NOT `!== 'unreadable'` -- that inverts the safe default.
     */
    public static function isCredit(array $r): bool
    {
        return ($r['state'] ?? '') === self::CREDITED
            && isset($r['usd_total']) && is_numeric($r['usd_total']) && $r['usd_total'] > 0;
    }

    /** A message safe to show a customer. Never leaks an internal reason. */
    public static function humanMessage(array $r): string
    {
        return match ($r['state'] ?? '') {
            self::CREDITED        => 'Payment confirmed and credited.',
            self::ALREADY_CLAIMED => 'That transaction has already been credited.',
            self::PENDING         => 'We cannot see that transaction yet. Give it a minute and try again.',
            self::CONFIRMING      => sprintf('Payment seen — waiting for confirmations (%s/%s).',
                                             $r['confirmations'] ?? '?', $r['required'] ?? '?'),
            self::NO_PAYMENT      => 'That transaction did not send wPCN to our payment address.',
            self::REVERTED        => 'That transaction failed on the blockchain, so nothing was sent.',
            self::REORGED         => 'That block is being reorganised. Try again shortly.',
            self::BAD_REQUEST     => 'That does not look like a BSC transaction hash.',
            // The important one. This is NOT "you did not pay" -- it is "we could
            // not check". Saying the wrong thing here makes a paying customer
            // think they were robbed.
            default               => 'We could not reach the blockchain just now. '
                                   . 'Your payment is safe — please try again in a minute.',
        };
    }

    // ------------------------------------------------------------------ HTTP

    private function post(string $path, array $body): array
    {
        return $this->request($path, json_encode($body, JSON_THROW_ON_ERROR));
    }

    private function get(string $path): array
    {
        return $this->request($path, null);
    }

    private function request(string $path, ?string $body): array
    {
        $ch = curl_init($this->endpoint . $path);
        $headers = ['Authorization: Bearer ' . $this->token, 'Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeoutS,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_POST           => $body !== null,
            CURLOPT_POSTFIELDS     => $body,
        ]);
        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        // No curl_close(): it has been a no-op since PHP 8.0 and is deprecated in
        // 8.5, where it prints a notice into whatever the caller is rendering.
        unset($ch);

        // Transport died. This resolves nothing.
        if ($raw === false || $code === 0) {
            return ['state' => self::UNREADABLE, 'message' => $err ?: 'transport failed'];
        }
        $j = json_decode((string) $raw, true);
        // A body we cannot parse is not an answer either. In particular it is not
        // an empty result set, which is how a proxy error page becomes "no payment".
        if (!is_array($j) || !isset($j['state'])) {
            return ['state' => self::UNREADABLE, 'message' => 'unparseable reply (HTTP ' . $code . ')'];
        }
        // 401/403/404 mean the CALLER is misconfigured, which is a deployment bug,
        // not a customer's failed payment. Surface it as unreadable so nothing is
        // resolved, and log it loudly on your side.
        if ($code === 401 || $code === 403 || $code === 404) {
            return ['state' => self::UNREADABLE, 'message' => 'verifier rejected this client (HTTP ' . $code . ')'];
        }
        return $j;
    }
}
