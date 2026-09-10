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

        // 64 hex, whitespace, the miner zip, whitespace, "# vX.Y.Z".
        // Anchored on the FILENAME so the wallet zip and the APKs cannot match.
        static readonly Regex Line = new Regex(
            @"^[0-9a-fA-F]{64}\s+pcoin-win64-miner\.zip\s+#\s*v([0-9]+(?:\.[0-9]+)*)\s*$",
            RegexOptions.Multiline);

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
            string body;
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
                    _lastModified = resp.Headers["Last-Modified"];
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

            var m = Line.Match(body ?? "");
            if (!m.Success)
            {
                info.Detail = "the published checksum list did not name a miner version";
                return info;                    // Unknown, deliberately
            }

            info.Latest = m.Groups[1].Value;
            _lastSeenVersion = info.Latest;
            int cmp = Compare(info.Latest, Build.Version);
            info.State = cmp > 0 ? UpdateState.Available : UpdateState.UpToDate;
            return info;
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
