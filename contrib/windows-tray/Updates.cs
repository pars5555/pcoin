// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// "Is there a newer PCoin, and can I have it without leaving this menu?"
//
// WHY THIS EXISTS. Until now the answer was no, twice over: the app never
// checked its version against anything, and there was no way to update from
// inside it. A user had to notice a Telegram post, find pc.am, and paste a
// PowerShell one-liner. A real one said so on 2026-09-09 -- "It is a few
// versions behind now and I would like to update it but I am not sure what the
// process is" -- and they were not confused, there genuinely was no mechanism.
//
// WHERE THE ANSWER COMES FROM, and why not the obvious place. NOT
// api.github.com/.../releases/latest: GitHub resolves `latest` to the newest
// RELEASE first, and this project ships Android and wallet releases from the
// same repo, so the moment one of those is newest the miner reads its own
// version as whatever that tag is. That exact mechanism already broke every
// download link on pc.am once (CLAUDE.md §4, "REPEALED as of v1.2.7").
//
// It comes from https://pc.am/dl/SHA256SUMS.txt, which the release process
// already has to update -- install.ps1's pinned hash has to match it or every
// new install refuses. One source of truth that cannot drift on its own,
// instead of a second file somebody has to remember.
//
// UNKNOWN IS NOT "UP TO DATE". A failed fetch, a timeout, an unparseable file:
// each leaves the state Unknown and says so. Reporting "you are up to date"
// off a read that did not happen is the §7.1 mistake, and here it would mean
// someone sits on a broken build believing it is current.

using System;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;

namespace PCoinTray
{
    enum UpdateState { Unknown, UpToDate, Available }

    class UpdateInfo
    {
        public UpdateState State = UpdateState.Unknown;
        public string Latest = "";     // e.g. "1.4.11"
        public string Detail = "";     // why, when Unknown
    }

    static class Updates
    {
        public const string SumsUrl = "https://pc.am/dl/SHA256SUMS.txt";

        // WHAT THE PUBLISHED FILE ACTUALLY LOOKS LIKE. There is no version on
        // the checksum line. The provenance is a comment line ABOVE it:
        //
        //   # from release v1.4.28
        //   bda6979d...bde5f  pcoin-win64-miner.zip
        //
        // The previous regex wanted "<hash>  <file>  # vX.Y.Z" -- a shape this
        // file has never used -- so it never matched, and the menu has read
        // "Check for updates..." in every release since this was added.
        //
        // It did not merely fail, which is why the replacement is a line walk
        // and not a cleverer regex: \s matches \n, so the old pattern crossed
        // onto the NEXT line, matched "# v1.4.7" from the Android entry, and
        // only failed on the em dash after it. One character of prose stood
        // between us and reporting the Android version as the miner's.
        //
        // So: only "# from release vX.Y.Z" is authoritative, and only for the
        // checksum line it precedes. The interleaved release notes carry OTHER
        // versions as plain prose ("# v1.4.19 - Windows miner. ..." sits nine
        // lines above the miner's own entry), and anything anchored on "the
        // nearest # vX.Y.Z" reads that stale number instead.
        const string MinerAsset = "pcoin-win64-miner.zip";

        static readonly Regex FromRelease = new Regex(
            @"^#\s*from\s+release\s+v?([0-9]+(?:\.[0-9]+)*)\s*$",
            RegexOptions.IgnoreCase);

        // "<64 hex>  <filename>" -- two spaces in practice, any whitespace run
        // accepted. The trailing "# vX.Y.Z" is optional and preferred when
        // present, so if the file ever does move the version inline this keeps
        // working instead of needing a second emergency release.
        static readonly Regex SumLine = new Regex(
            @"^([0-9a-fA-F]{64})\s+(\S+)(?:\s+#\s*v?([0-9]+(?:\.[0-9]+)*))?\s*$");

        // Remembered between checks so the NEXT one can be conditional. This is
        // a long-lived process -- days -- so a client that has already seen the
        // file asks "has it changed since?" instead of downloading it again.
        //
        // Measured against the live server: a plain GET is 3,665 bytes, and
        // If-Modified-Since returns 304 with ZERO bytes. ETag does NOT work
        // here -- Apache emits a weak, -gzip-suffixed ETag that does not match
        // back through Cloudflare, so If-None-Match answers 200 every time.
        // Using it would have looked correct and quietly done nothing.
        static string _lastModified;
        static string _lastSeenVersion;

        public static UpdateInfo Check()
        {
            var info = new UpdateInfo();
            string body, lastMod = null;
            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                var req = (HttpWebRequest)WebRequest.Create(SumsUrl);
                req.UserAgent = "PCoinTray/" + Build.Version;
                req.Timeout = 20000;
                req.ReadWriteTimeout = 20000;
                req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
                if (_lastModified != null)
                {
                    DateTime since;
                    if (DateTime.TryParse(_lastModified, CultureInfo.InvariantCulture,
                                          DateTimeStyles.AdjustToUniversal, out since))
                        req.IfModifiedSince = since;
                }
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(resp.GetResponseStream()))
                {
                    body = sr.ReadToEnd();
                    // Held in a LOCAL until the body has actually parsed. Committing
                    // it here is what turned this bug into a lie: the first check
                    // said "the list did not name a miner version", and every check
                    // after it sent If-Modified-Since, got 304, found no remembered
                    // version, and reported "could not reach pc.am" about a server
                    // that had answered correctly. The conditional-GET cache and the
                    // parsed answer must be committed together or they disagree.
                    lastMod = resp.Headers["Last-Modified"];
                }
            }
            catch (WebException wex)
            {
                var hr = wex.Response as HttpWebResponse;
                if (hr != null && hr.StatusCode == HttpStatusCode.NotModified && _lastSeenVersion != null)
                {
                    // Nothing changed since we last looked, and we still know
                    // what it said. Zero bytes crossed the wire.
                    info.Latest = _lastSeenVersion;
                    info.State = Compare(_lastSeenVersion, Build.Version) > 0
                               ? UpdateState.Available : UpdateState.UpToDate;
                    return info;
                }
                info.Detail = "could not reach pc.am (" + wex.Message + ")";
                return info;                    // Unknown, deliberately
            }
            catch (Exception ex)
            {
                info.Detail = "could not reach pc.am (" + ex.Message + ")";
                return info;                    // Unknown, deliberately
            }

            string why;
            string latest = ParseLatest(body, out why);
            if (latest == null)
            {
                info.Detail = why;
                return info;                    // Unknown, deliberately
            }

            info.Latest = latest;
            _lastSeenVersion = info.Latest;
            _lastModified = lastMod;            // only NOW is a 304 answerable
            int cmp = Compare(info.Latest, Build.Version);
            info.State = cmp > 0 ? UpdateState.Available : UpdateState.UpToDate;
            return info;
        }

        //! Read the miner's version out of the published checksum list.
        //! Returns null -- never a guess -- when the file does not say so, and
        //! fills `why` with something a user can act on. UNKNOWN IS NOT
        //! "UP TO DATE"; this is where that is enforced.
        //!
        //! Line by line rather than one Multiline regex, because the fact and
        //! the entry it describes live on DIFFERENT lines, and a provenance
        //! line belongs to the NEXT checksum entry only. Clearing `pending` at
        //! every checksum line is the load-bearing part: without it, a miner
        //! entry that had lost its own "# from release" would silently inherit
        //! the Linux .deb's version from further up the file.
        //! Blank and prose lines do NOT clear it, so a provenance line may
        //! stand a line or two above its entry; a checksum line for any OTHER
        //! asset does clear it, which is what stops another asset's tag leaking
        //! onto the miner. A "*filename" binary marker would not match
        //! MinerAsset and correctly reads as Unknown, not as a guess.
        static string ParseLatest(string body, out string why)
        {
            why = "";
            string pending = null, best = null;
            bool sawAsset = false;
            foreach (string raw in (body ?? "").Split('\n'))
            {
                string line = raw.TrimEnd('\r', ' ', '\t');

                Match f = FromRelease.Match(line);
                if (f.Success) { pending = f.Groups[1].Value; continue; }

                Match s = SumLine.Match(line);
                if (!s.Success) continue;       // preamble, prose, blank, bare "#"

                if (string.Equals(s.Groups[2].Value, MinerAsset, StringComparison.OrdinalIgnoreCase))
                {
                    sawAsset = true;
                    string ver = s.Groups[3].Success ? s.Groups[3].Value : pending;
                    // Highest wins, numerically, so a leftover transition-alias
                    // entry can never talk somebody into a downgrade.
                    if (ver != null && (best == null || Compare(ver, best) > 0)) best = ver;
                }
                pending = null;                 // spent, or spent on another asset
            }

            if (best == null)
                why = sawAsset
                    ? "the published checksum list names " + MinerAsset +
                      " but no release above it"
                    : "the published checksum list does not name " + MinerAsset;
            return best;
        }

        //! Numeric, component by component -- NOT string comparison, which puts
        //! "1.4.9" above "1.4.10" and would have told every user of the newest
        //! build to downgrade. Missing components count as zero, so 1.4 == 1.4.0.
        public static int Compare(string a, string b)
        {
            string[] xs = (a ?? "").Split('.'), ys = (b ?? "").Split('.');
            int n = Math.Max(xs.Length, ys.Length);
            for (int i = 0; i < n; i++)
            {
                int x = 0, y = 0;
                if (i < xs.Length) int.TryParse(xs[i], NumberStyles.None, CultureInfo.InvariantCulture, out x);
                if (i < ys.Length) int.TryParse(ys[i], NumberStyles.None, CultureInfo.InvariantCulture, out y);
                if (x != y) return x < y ? -1 : 1;
            }
            return 0;
        }
    }
}
