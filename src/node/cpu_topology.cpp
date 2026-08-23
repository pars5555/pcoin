// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#include <node/cpu_topology.h>

#include <algorithm>
#include <mutex>
#include <thread>

#ifdef WIN32
#include <windows.h>
#include <vector>
#else
#include <cstdlib>
#include <fstream>
#include <set>
#include <string>
#include <utility>
#endif

namespace node {

namespace {

constexpr uint64_t SCRATCHPAD_BYTES{2 * 1024 * 1024}; //!< RANDOMX_SCRATCHPAD_L3

#ifdef WIN32
//! Physical cores and total L3 via GetLogicalProcessorInformation (the fixed-
//! record, non-Ex API). Deliberately not the Ex variant: its records are
//! variable-length and its PROCESSOR_RELATIONSHIP::EfficiencyClass does not
//! compile under the mingw-w64 toolchain that builds the shipped win64 node.
//! The non-Ex API caps at 64 logical processors in one group, which every
//! machine PCoin runs on is well under, and it returns ONE RelationCache record
//! per distinct cache instance -- so summing the level-3 records counts a shared
//! L3 once and a chiplet's several L3s whole, with no dedupe needed.
void ReadWindows(int& physical, uint64_t& l3)
{
    DWORD len{0};
    GetLogicalProcessorInformation(nullptr, &len); // sizing call; expected to fail
    if (len == 0) return;
    std::vector<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> buf(
        len / sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION));
    if (buf.empty()) return;
    if (!GetLogicalProcessorInformation(buf.data(), &len)) return;
    for (const auto& e : buf) {
        if (e.Relationship == RelationProcessorCore) {
            ++physical;
        } else if (e.Relationship == RelationCache && e.Cache.Level == 3 &&
                   (e.Cache.Type == CacheUnified || e.Cache.Type == CacheData)) {
            l3 += e.Cache.Size;
        }
    }
}
#else
//! Read a whole small sysfs/proc file into `out`. Returns false if absent.
bool ReadFile(const std::string& path, std::string& out)
{
    std::ifstream f{path};
    if (!f.is_open()) return false;
    std::string line;
    std::getline(f, out);
    return true;
}

//! Physical cores = distinct (physical package id, core id) pairs in
//! /proc/cpuinfo; L3 = sum over distinct level-3 caches in sysfs, deduped by
//! shared_cpu_list so a shared cache is counted once and a chiplet part whole.
void ReadLinux(int logical, int& physical, uint64_t& l3)
{
    // Physical cores from /proc/cpuinfo. On x86 every processor block carries
    // "physical id" and "core id"; the number of distinct pairs is the physical
    // core count. If the fields are absent (some non-x86 kernels), physical is
    // left at 0 = unknown, which is the honest answer.
    {
        std::ifstream f{"/proc/cpuinfo"};
        if (f.is_open()) {
            std::set<std::pair<int, int>> cores;
            std::string line;
            int pkg{-1}, core{-1};
            bool have_pkg{false}, have_core{false};
            auto flush = [&] {
                if (have_pkg && have_core) cores.insert({pkg, core});
                pkg = core = -1;
                have_pkg = have_core = false;
            };
            while (std::getline(f, line)) {
                if (line.empty()) { flush(); continue; }
                const auto colon{line.find(':')};
                if (colon == std::string::npos) continue;
                const std::string key{line.substr(0, colon)};
                const std::string val{line.substr(colon + 1)};
                if (key.rfind("physical id", 0) == 0) { pkg = std::atoi(val.c_str()); have_pkg = true; }
                else if (key.rfind("core id", 0) == 0) { core = std::atoi(val.c_str()); have_core = true; }
            }
            flush(); // last block may not end in a blank line
            physical = static_cast<int>(cores.size());
        }
    }

    // L3 from /sys/devices/system/cpu/cpu*/cache/index*/, deduped by
    // shared_cpu_list. Size strings look like "19712K" or "16M".
    std::set<std::string> counted;
    for (int cpu = 0; cpu < std::max(logical, 1) && cpu < 4096; ++cpu) {
        const std::string base{"/sys/devices/system/cpu/cpu" + std::to_string(cpu) + "/cache/"};
        for (int idx = 0; idx < 16; ++idx) {
            const std::string dir{base + "index" + std::to_string(idx) + "/"};
            std::string level;
            if (!ReadFile(dir + "level", level)) break; // no more cache indices
            if (level != "3") continue;
            std::string shared;
            ReadFile(dir + "shared_cpu_list", shared);
            if (!counted.insert(shared.empty() ? dir : shared).second) continue; // already counted
            std::string size;
            if (!ReadFile(dir + "size", size) || size.empty()) continue;
            char unit{size.back()};
            uint64_t mult{1};
            if (unit == 'K' || unit == 'k') { mult = 1024; size.pop_back(); }
            else if (unit == 'M' || unit == 'm') { mult = 1024 * 1024; size.pop_back(); }
            l3 += static_cast<uint64_t>(std::strtoull(size.c_str(), nullptr, 10)) * mult;
        }
    }
}
#endif

CpuTopology Detect()
{
    CpuTopology t;
    t.logical = std::max(0, static_cast<int>(std::thread::hardware_concurrency()));
#ifdef WIN32
    ReadWindows(t.physical, t.l3_bytes);
#elif defined(__linux__)
    ReadLinux(t.logical, t.physical, t.l3_bytes);
#endif
    // A topology that read more physical cores than logical processors is
    // nonsense; treat it as unreadable rather than trust it.
    if (t.physical > t.logical && t.logical > 0) t.physical = 0;
    return t;
}

} // namespace

CpuTopology GetCpuTopology()
{
    static const CpuTopology cached{Detect()};
    return cached;
}

int FastModeThreadTarget(const CpuTopology& topo)
{
    const int logical{std::max(1, topo.logical)};
    if (topo.physical <= 0) {
        // Unknown topology: half the logical processors. Right on every HT
        // machine, conservative on the rest; never "all of them", which is the
        // measured-harmful answer in fast mode.
        return std::max(1, logical / 2);
    }
    if (topo.physical >= logical) {
        // No hyperthreading: no cliff, and a light-mode fallback wants them all.
        return logical;
    }
    int useful{topo.physical};
    if (topo.l3_bytes > 0) {
        const int by_cache{static_cast<int>(topo.l3_bytes / SCRATCHPAD_BYTES)};
        useful = std::min(useful, std::max(1, by_cache));
    }
    return std::max(1, std::min(useful, logical));
}

int FastModeThreadAdvice(const CpuTopology& topo)
{
    const int logical{std::max(1, topo.logical)};
    // Advice only where the data supports it: a real, hyperthreaded machine
    // whose peak is fewer than all its logical processors. Everywhere else there
    // is nothing honest to advise, so say nothing (0).
    if (topo.physical <= 0 || topo.physical >= logical) return 0;
    const int target{FastModeThreadTarget(topo)};
    return target < logical ? target : 0;
}

} // namespace node
