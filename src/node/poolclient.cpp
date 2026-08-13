// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <node/poolclient.h>

#include <compat/compat.h>
#include <logging.h>
#include <netbase.h>
#include <streams.h>
#include <tinyformat.h>
#include <uint256.h>
#include <util/sock.h>
#include <util/strencodings.h>

#include <algorithm>
#include <cstring>

namespace node {

namespace {
enum RequestKind { REQ_LOGIN = 1, REQ_SUBMIT = 2, REQ_KEEPALIVE = 3 };

//! Cap the receive buffer. A pool that never sends a newline is a pool that
//! would otherwise grow this without bound.
constexpr size_t MAX_RX{256 * 1024};
//! And cap the submit backlog. If the pool has stopped reading, dropping the
//! oldest solved nonces is better than growing a queue forever -- they are
//! stale work by then anyway.
constexpr size_t MAX_PENDING_SUBMITS{256};
constexpr auto KEEPALIVE_INTERVAL{std::chrono::seconds{30}};
constexpr int MAX_BACKOFF_SECONDS{30};
//! An allowlist refusal is a decision, not a hiccup. Retrying it every second
//! achieves nothing except filling somebody's log.
constexpr int REFUSED_BACKOFF_SECONDS{120};
} // namespace

PoolClient::PoolClient(std::string host, uint16_t port, std::string user)
    : m_host{std::move(host)}, m_port{port}, m_user{std::move(user)}
{
    std::lock_guard<std::mutex> lock(m_status_mutex);
    m_status = "not connected yet";
}

PoolClient::~PoolClient() { Close(); }

std::string PoolClient::Describe() const { return m_host + ":" + std::to_string(m_port); }

std::string PoolClient::GetStatus() const
{
    std::lock_guard<std::mutex> lock(m_status_mutex);
    return m_status;
}

void PoolClient::Close()
{
    m_sock.reset();
    m_rx.clear();
    m_session.clear();
    {
        std::lock_guard<std::mutex> lock(m_inflight_mutex);
        m_inflight.clear();
    }
    // The job goes with the connection. A job from a pool we are no longer
    // talking to is work nobody will pay for, and grinding it looks exactly
    // like working to anyone watching the hashrate.
    {
        std::lock_guard<std::mutex> lock(m_job_mutex);
        m_have_job = false;
    }
}

void PoolClient::Fail(const std::string& why, bool refused)
{
    Close();
    {
        std::lock_guard<std::mutex> lock(m_status_mutex);
        m_status = why;
    }
    m_state = refused ? PoolState::REFUSED : PoolState::DISCONNECTED;
    const int wait{refused ? REFUSED_BACKOFF_SECONDS : m_backoff_seconds};
    m_retry_at = std::chrono::steady_clock::now() + std::chrono::seconds{wait};
    if (!refused) m_backoff_seconds = std::min(MAX_BACKOFF_SECONDS, m_backoff_seconds * 2);
    LogPrintf("PCoin pool miner: %s (retrying in %ds)\n", why, wait);
}

bool PoolClient::Connect()
{
    m_state = PoolState::CONNECTING;
    {
        std::lock_guard<std::mutex> lock(m_status_mutex);
        m_status = "connecting to " + Describe();
    }

    const std::optional<CService> addr{Lookup(m_host, m_port, /*fAllowLookup=*/true)};
    if (!addr.has_value()) {
        Fail("cannot resolve " + m_host, /*refused=*/false);
        return false;
    }
    // manual_connection=true: this is an operator-configured destination, not a
    // peer we found by gossip, so it is not subject to the P2P proxy policy.
    m_sock = ConnectDirectly(*addr, /*manual_connection=*/true);
    if (!m_sock) {
        Fail("cannot connect to " + Describe(), /*refused=*/false);
        return false;
    }

    m_state = PoolState::LOGGING_IN;
    {
        std::lock_guard<std::mutex> lock(m_status_mutex);
        m_status = "logging in to " + Describe();
    }

    int64_t id;
    {
        std::lock_guard<std::mutex> lock(m_inflight_mutex);
        id = m_next_id++;
        m_inflight[id] = REQ_LOGIN;
    }
    UniValue params(UniValue::VOBJ);
    params.pushKV("login", m_user);
    params.pushKV("pass", "x");
    params.pushKV("agent", "pcoind");
    UniValue req(UniValue::VOBJ);
    req.pushKV("id", id);
    req.pushKV("method", "login");
    req.pushKV("params", params);
    SendLine(req.write());
    m_last_keepalive = std::chrono::steady_clock::now();
    return true;
}

void PoolClient::SendLine(const std::string& line)
{
    if (!m_sock) return;
    const std::string out{line + "\n"};
    size_t sent{0};
    while (sent < out.size()) {
        const ssize_t n{m_sock->Send(out.data() + sent, out.size() - sent, MSG_NOSIGNAL)};
        if (n <= 0) {
            // Do NOT treat a failed send as "the pool rejected it". It is an
            // unknown: the request may or may not have arrived. Drop the
            // connection and start again -- on reconnect the pool issues a
            // fresh job, so nothing is left half-submitted against a job that
            // no longer exists.
            Fail("lost connection to " + Describe() + " while sending", /*refused=*/false);
            return;
        }
        sent += static_cast<size_t>(n);
    }
}

void PoolClient::QueueSubmit(const std::string& job_id, uint32_t nonce)
{
    std::lock_guard<std::mutex> lock(m_submit_mutex);
    if (m_pending_submits.size() >= MAX_PENDING_SUBMITS) m_pending_submits.pop_front();
    m_pending_submits.push_back({job_id, nonce});
}

bool PoolClient::GetJob(PoolJob& out) const
{
    std::lock_guard<std::mutex> lock(m_job_mutex);
    if (!m_have_job) return false;
    out = m_job;
    return true;
}

void PoolClient::SetJob(const UniValue& job, bool from_login)
{
    // EVERY field is checked. This is data from the network, and a job that is
    // wrong in a way we do not notice is a machine that hashes at full speed
    // and earns nothing -- the most expensive possible failure, because it
    // looks exactly like success on every dial the user can see.
    if (!job.isObject()) return;
    const UniValue& blob{job.find_value("blob")};
    const UniValue& target{job.find_value("target")};
    const UniValue& job_id{job.find_value("job_id")};
    if (!blob.isStr() || !target.isStr() || !job_id.isStr()) {
        LogPrintf("PCoin pool miner: ignoring a job with missing fields\n");
        return;
    }

    const auto bytes{TryParseHex<uint8_t>(blob.get_str())};
    if (!bytes.has_value() || bytes->size() != 80) {
        LogPrintf("PCoin pool miner: ignoring a job whose blob is not 80 bytes\n");
        return;
    }
    CBlockHeader header;
    try {
        DataStream ss{*bytes};
        ss >> header;
    } catch (const std::exception& e) {
        LogPrintf("PCoin pool miner: ignoring an undecodable job blob (%s)\n", e.what());
        return;
    }

    const auto t{uint256::FromHex(target.get_str())};
    if (!t.has_value()) {
        LogPrintf("PCoin pool miner: ignoring a job with an unparseable target\n");
        return;
    }
    const arith_uint256 target_arith{UintToArith256(*t)};
    if (target_arith == 0) {
        // No hash can be below zero, so this job can never produce a share.
        // Refusing it is the difference between "the pool is misconfigured" and
        // "this machine mines all night for nothing".
        LogPrintf("PCoin pool miner: ignoring a job with a zero target\n");
        return;
    }

    const UniValue& h{job.find_value("height")};
    {
        std::lock_guard<std::mutex> lock(m_job_mutex);
        m_job.id = job_id.get_str();
        m_job.header = header;
        m_job.target = target_arith;
        m_job.height = h.isNum() ? h.getInt<int>() : 0;
        m_job.generation = ++m_job_seq;
        m_have_job = true;
        m_job_height = m_job.height;
    }
    m_state = PoolState::MINING;
    {
        std::lock_guard<std::mutex> lock(m_status_mutex);
        m_status.clear();
    }
    LogPrintf("PCoin pool miner: %s job %s for height %d\n",
              from_login ? "first" : "new", job_id.get_str(), h.isNum() ? h.getInt<int>() : 0);
}

void PoolClient::HandleLine(const std::string& line)
{
    UniValue msg;
    if (!msg.read(line) || !msg.isObject()) {
        LogPrintf("PCoin pool miner: ignoring an unparseable line from the pool\n");
        return;
    }

    // A pushed job: no id, method "job".
    const UniValue& method{msg.find_value("method")};
    if (method.isStr() && method.get_str() == "job") {
        SetJob(msg.find_value("params"), /*from_login=*/false);
        return;
    }

    const UniValue& id{msg.find_value("id")};
    if (!id.isNum()) return;
    int kind{0};
    {
        std::lock_guard<std::mutex> lock(m_inflight_mutex);
        auto it{m_inflight.find(id.getInt<int64_t>())};
        if (it == m_inflight.end()) return;   // unmatched: ignore, never guess
        kind = it->second;
        m_inflight.erase(it);
    }

    const UniValue& err{msg.find_value("error")};
    const UniValue& result{msg.find_value("result")};

    if (kind == REQ_LOGIN) {
        if (!err.isNull()) {
            const UniValue& m{err.isObject() ? err.find_value("message") : err};
            const std::string why{m.isStr() ? m.get_str() : "the pool refused the login"};
            // A refusal is an ANSWER -- the allowlist, a bad address -- and it
            // will not fix itself in a second. Say what the pool said, verbatim,
            // because it is the only thing the user can act on.
            Fail("pool refused this address: " + why, /*refused=*/true);
            return;
        }
        m_backoff_seconds = 1;
        const UniValue& sid{result.isObject() ? result.find_value("id") : NullUniValue};
        if (sid.isStr()) m_session = sid.get_str();
        if (result.isObject()) SetJob(result.find_value("job"), /*from_login=*/true);
        return;
    }

    if (kind == REQ_SUBMIT) {
        if (!err.isNull()) {
            m_rejected++;
            const UniValue& m{err.isObject() ? err.find_value("message") : err};
            LogPrintf("PCoin pool miner: share rejected (%s)\n",
                      m.isStr() ? m.get_str() : "no reason given");
        } else {
            m_accepted++;
        }
        return;
    }
    // Keepalive replies carry nothing worth acting on.
}

void PoolClient::FlushSubmits()
{
    std::deque<Submission> batch;
    {
        std::lock_guard<std::mutex> lock(m_submit_mutex);
        batch.swap(m_pending_submits);
    }
    for (const auto& s : batch) {
        if (!m_sock) {
            // The connection went away while draining. These nonces are for a
            // job the pool will re-issue anyway; dropping them loses a few
            // shares, which is the correct cost. Do not count them as rejected
            // -- the pool never saw them, and a rejection is a statement about
            // work the pool judged.
            break;
        }
        int64_t id;
        {
            std::lock_guard<std::mutex> lock(m_inflight_mutex);
            id = m_next_id++;
            m_inflight[id] = REQ_SUBMIT;
        }
        UniValue params(UniValue::VOBJ);
        params.pushKV("id", m_session);
        params.pushKV("job_id", s.job_id);
        params.pushKV("nonce", strprintf("%08x", s.nonce));
        UniValue req(UniValue::VOBJ);
        req.pushKV("id", id);
        req.pushKV("method", "submit");
        req.pushKV("params", params);
        SendLine(req.write());
        m_submitted++;
    }
}

void PoolClient::Pump(std::chrono::milliseconds budget)
{
    const auto now{std::chrono::steady_clock::now()};

    if (!m_sock) {
        if (now < m_retry_at) return;
        if (!Connect()) return;
    }

    // Read whatever is waiting.
    Sock::Event occurred{0};
    if (!m_sock->Wait(budget, Sock::RECV, &occurred)) {
        Fail("connection to " + Describe() + " failed while waiting", /*refused=*/false);
        return;
    }
    if (occurred & Sock::ERR) {
        Fail("connection to " + Describe() + " errored", /*refused=*/false);
        return;
    }
    if (occurred & Sock::RECV) {
        char buf[8192];
        const ssize_t n{m_sock->Recv(buf, sizeof(buf), MSG_DONTWAIT)};
        if (n == 0) {
            Fail("pool " + Describe() + " closed the connection", /*refused=*/false);
            return;
        }
        if (n < 0) {
            const int e{WSAGetLastError()};
            if (e != WSAEWOULDBLOCK && e != WSAEMSGSIZE && e != WSAEINTR && e != WSAEINPROGRESS) {
                Fail("read from " + Describe() + " failed", /*refused=*/false);
                return;
            }
        } else {
            m_rx.append(buf, static_cast<size_t>(n));
            if (m_rx.size() > MAX_RX) {
                Fail("pool " + Describe() + " sent an oversized line", /*refused=*/false);
                return;
            }
            size_t pos;
            while ((pos = m_rx.find('\n')) != std::string::npos) {
                std::string line{m_rx.substr(0, pos)};
                m_rx.erase(0, pos + 1);
                while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
                if (!line.empty()) HandleLine(line);
                if (!m_sock) return;  // HandleLine may have dropped us
            }
        }
    }

    if (!m_sock) return;
    FlushSubmits();

    if (m_sock && std::chrono::steady_clock::now() - m_last_keepalive >= KEEPALIVE_INTERVAL) {
        int64_t id;
        {
            std::lock_guard<std::mutex> lock(m_inflight_mutex);
            id = m_next_id++;
            m_inflight[id] = REQ_KEEPALIVE;
        }
        UniValue params(UniValue::VOBJ);
        params.pushKV("id", m_session);
        UniValue req(UniValue::VOBJ);
        req.pushKV("id", id);
        req.pushKV("method", "keepalived");
        req.pushKV("params", params);
        SendLine(req.write());
        m_last_keepalive = std::chrono::steady_clock::now();
    }
}

} // namespace node
