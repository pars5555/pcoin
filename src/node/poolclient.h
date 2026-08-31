// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef BITCOIN_NODE_POOLCLIENT_H
#define BITCOIN_NODE_POOLCLIENT_H

#include <arith_uint256.h>
#include <primitives/block.h>
#include <univalue.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>

class Sock;

namespace node {

/**
 * One unit of work handed out by a mining pool.
 *
 * The difference from solo mining is entirely in `target`. Solo mining checks a
 * candidate against the NETWORK target, and only a real block passes. A pool
 * hands out an easier target, so most passing hashes are merely *shares* --
 * proof that work was done -- and roughly one in `factor` of them also clears
 * the network target and is a block. The miner cannot tell the difference and
 * does not need to: it submits everything that beats `target` and the pool
 * decides what it has.
 */
struct PoolJob {
    std::string id;
    CBlockHeader header;   //!< the pool's 80 bytes; the nonce is ours to fill in
    arith_uint256 target;  //!< a share must hash <= this. NOT the network target.
    int height{0};
    uint64_t generation{0}; //!< bumped on every new job; workers restart on change
};

enum class PoolState {
    DISCONNECTED, //!< no socket; will retry after a backoff
    CONNECTING,
    LOGGING_IN,
    MINING,       //!< logged in and holding a job
    REFUSED,      //!< the pool said no. Backs off hard; see m_refusal
};

/**
 * A client for PCoin's mining pool, speaking the Monero-style stratum-like
 * convention over a raw TCP line protocol (`login`, `job`, `submit`,
 * `keepalived`), one JSON object per line.
 *
 * THREADING, which is the whole design:
 *
 *   - Every byte of socket I/O happens on ONE thread, the mining supervisor,
 *     inside Pump(). Nothing else touches the socket.
 *   - Workers hand solved nonces back through QueueSubmit(), which appends to a
 *     mutex-protected queue and returns immediately. A worker must never block
 *     on the network: it holds no lock the supervisor needs, but a stalled TCP
 *     write inside a hashing loop would idle a core for as long as the pool
 *     took to read, and a pool that stops reading would silently halve the
 *     machine's hashrate with nothing anywhere saying why.
 *   - GetJob() takes a short mutex and copies. Workers call it once per nonce
 *     batch, not per hash.
 *
 * A pool that misbehaves -- disconnects, sends garbage, stops answering -- must
 * never do worse than stop this node's mining. It cannot affect validation, it
 * cannot affect the chainstate, and nothing it sends is trusted beyond being
 * hashed: the pool supplies 80 bytes and a target, and the worst a malicious
 * pool can do is waste the miner's electricity on work that pays nobody.
 */
class PoolClient
{
public:
    PoolClient(std::string host, uint16_t port, std::string user);
    ~PoolClient();

    PoolClient(const PoolClient&) = delete;
    PoolClient& operator=(const PoolClient&) = delete;

    /**
     * One iteration of the client: connect if needed, read whatever is waiting,
     * flush queued submissions, send a keepalive if one is due.
     *
     * Blocks for at most `budget`. SUPERVISOR THREAD ONLY.
     */
    void Pump(std::chrono::milliseconds budget);

    //! Drop the connection. Safe to call when not connected.
    void Close();

    //! Hand back a nonce that beat the share target. Thread-safe, never blocks.
    void QueueSubmit(const std::string& job_id, uint32_t nonce);

    //! Copy the current job. False if there is none. Thread-safe.
    bool GetJob(PoolJob& out) const;

    PoolState GetState() const { return m_state.load(); }
    uint64_t SharesAccepted() const { return m_accepted.load(); }
    uint64_t SharesRejected() const { return m_rejected.load(); }
    uint64_t SharesSubmitted() const { return m_submitted.load(); }
    int JobHeight() const { return m_job_height.load(); }

    //! host:port, for logs and RPC.
    std::string Describe() const;

    /**
     * Why mining is not happening, in words, or empty when it is.
     *
     * This is the only thing a user will ever see when a pool refuses them --
     * an allowlist rejection, a bad address, a dead host -- so it must never be
     * empty while something is wrong. The fleet supervisors read RPC and never
     * read logs.
     */
    std::string GetStatus() const;

private:
    bool Connect();
    void SendLine(const std::string& line);
    void HandleLine(const std::string& line);
    void SetJob(const UniValue& job, bool from_login);
    void FlushSubmits();
    void Fail(const std::string& why, bool refused);

    const std::string m_host;
    const uint16_t m_port;
    const std::string m_user;

    std::unique_ptr<Sock> m_sock;
    std::string m_rx;                 //!< partial line buffer
    std::string m_session;            //!< id the pool gave us at login

    mutable std::mutex m_job_mutex;
    PoolJob m_job;
    bool m_have_job{false};
    uint64_t m_job_seq{0};

    mutable std::mutex m_submit_mutex;
    struct Submission { std::string job_id; uint32_t nonce; };
    std::deque<Submission> m_pending_submits;

    //! Which request id was what, so a reply can be attributed. An unmatched
    //! reply is ignored rather than guessed at.
    mutable std::mutex m_inflight_mutex;
    std::map<int64_t, int> m_inflight;  //!< id -> RequestKind
    int64_t m_next_id{1};

    std::atomic<PoolState> m_state{PoolState::DISCONNECTED};
    std::atomic<uint64_t> m_accepted{0};
    std::atomic<uint64_t> m_rejected{0};
    std::atomic<uint64_t> m_submitted{0};
    //! Consecutive rejected submits with no acceptance in between.
    //! Pool-thread only (HandleLine/Close), so it needs no atomicity.
    int m_consecutive_rejects{0};
    std::atomic<int> m_job_height{0};

    mutable std::mutex m_status_mutex;
    std::string m_status;             //!< human-readable reason, or empty

    std::chrono::steady_clock::time_point m_retry_at{};
    std::chrono::steady_clock::time_point m_last_keepalive{};
    int m_backoff_seconds{1};
};

} // namespace node

#endif // BITCOIN_NODE_POOLCLIENT_H
