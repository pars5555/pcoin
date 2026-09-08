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

    /**
     * Every claim banked to this project for one user. Read-only.
     *
     * Returns ['ok' => true, 'project' => …, 'claims' => [...]] on success, or
     * ['state' => 'unreadable', …] if we could not get an answer. It does NOT
     * return a verify-shaped reply, because /claims carries no 'state' — see
     * the shape note on request().
     */
    public function claims(string $userRef): array
    {
        return $this->get('/claims?user_ref=' . rawurlencode($userRef), 'claims');
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
        return $this->request($path, json_encode($body, JSON_THROW_ON_ERROR), 'verify');
    }

    private function get(string $path, string $shape = 'verify'): array
    {
        return $this->request($path, null, $shape);
    }

    /**
     * @param string $shape which endpoint's reply we are validating.
     *
     * THIS USED TO BE ONE RULE FOR BOTH, AND IT WAS WRONG. /verify answers with
     * a top-level 'state'; /claims answers ['ok', 'project', 'claims'] and has
     * no 'state' at all. Demanding one turned every SUCCESSFUL /claims call
     * into 'unreadable' — which silently disabled the heal path in
     * INTEGRATION.md §9, the one that returns a customer's money after our own
     * write was lost. It failed safe (refused rather than double-credited), so
     * nothing broke loudly; it simply could never work. Found by the webai and
     * 3dmodel teams on 2026-09-08, both by reading the code rather than
     * trusting it.
     */
    private function request(string $path, ?string $body, string $shape = 'verify'): array
    {
        $ch = curl_init($this->endpoint . $path);
        $headers = ['Authorization: Bearer ' . $this->token, 'Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeoutS,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_HTTPHEADER     => $headers,
        ];
        // CURLOPT_POSTFIELDS is set ONLY when there is a body.
        //
        // Setting it at all — even to null — switches curl to POST, and
        // CURLOPT_POST => false does not undo that. This client therefore sent
        // "POST /claims" for its whole life, which the verifier answers with
        // 404 "no such endpoint". Combined with the reply-shape bug fixed
        // above, GET /claims could never succeed, and the heal path in
        // INTEGRATION.md §9 was unreachable in every PHP integration.
        // Confirmed by dumping CURLINFO_HEADER_OUT rather than by reasoning
        // about the flags.
        if ($body !== null) {
            $opts[CURLOPT_POST]       = true;
            $opts[CURLOPT_POSTFIELDS] = $body;
        } else {
            $opts[CURLOPT_HTTPGET] = true;
        }
        curl_setopt_array($ch, $opts);
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

        // 401/403/404 mean the CALLER is misconfigured, which is a deployment bug,
        // not a customer's failed payment. Surface it as unreadable so nothing is
        // resolved, and log it loudly on your side. Checked BEFORE the shape test
        // so a rejection reports why, instead of arriving as a vague "unparseable".
        if ($code === 401 || $code === 403 || $code === 404) {
            return ['state' => self::UNREADABLE, 'message' => 'verifier rejected this client (HTTP ' . $code . ')'];
        }

        // A body we cannot parse is not an answer either. In particular it is not
        // an empty result set, which is how a proxy error page becomes "no payment".
        $wellFormed = $shape === 'claims'
            ? (is_array($j) && ($j['ok'] ?? null) === true && isset($j['claims']) && is_array($j['claims']))
            : (is_array($j) && isset($j['state']) && is_string($j['state']));
        if (!$wellFormed) {
            return ['state' => self::UNREADABLE, 'message' => 'unparseable reply (HTTP ' . $code . ')'];
        }
        return $j;
    }
}
