// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// A small JSON-RPC client that talks to bitcoind over the loopback HTTP
// interface, plus the minimal JSON reader it needs.
//
// Why not bitcoin-cli, which the rest of this app uses? Because the wallet
// import sends an extended private key, and a command line is world-readable in
// the Windows process list and lands in shell history. Anything carrying key
// material MUST go over the socket. Core itself does not log RPC request
// bodies, so the key does not reach debug.log either.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace PCoinTray
{
    static class Json
    {
        // ---- reading ----

        public static object Parse(string s)
        {
            int i = 0;
            object v = ParseValue(s, ref i);
            return v;
        }

        static void Skip(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        static object ParseValue(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end of JSON");
            char c = s[i];
            if (c == '{') return ParseObject(s, ref i);
            if (c == '[') return ParseArray(s, ref i);
            if (c == '"') return ParseString(s, ref i);
            if (s.Length - i >= 4 && s.Substring(i, 4) == "true") { i += 4; return true; }
            if (s.Length - i >= 5 && s.Substring(i, 5) == "false") { i += 5; return false; }
            if (s.Length - i >= 4 && s.Substring(i, 4) == "null") { i += 4; return null; }
            int start = i;
            while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++;
            if (i == start) throw new FormatException("bad JSON value");
            return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        static Dictionary<string, object> ParseObject(string s, ref int i)
        {
            var d = new Dictionary<string, object>(StringComparer.Ordinal);
            i++;                                    // '{'
            Skip(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (true)
            {
                Skip(s, ref i);
                string k = ParseString(s, ref i);
                Skip(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':'");
                i++;
                d[k] = ParseValue(s, ref i);
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; return d; }
                throw new FormatException("expected ',' or '}'");
            }
        }

        static List<object> ParseArray(string s, ref int i)
        {
            var l = new List<object>();
            i++;                                    // '['
            Skip(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(ParseValue(s, ref i));
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; return l; }
                throw new FormatException("expected ',' or ']'");
            }
        }

        static string ParseString(string s, ref int i)
        {
            if (s[i] != '"') throw new FormatException("expected string");
            i++;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
            throw new FormatException("unterminated string");
        }

        // ---- writing ----

        public static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // ---- accessors that never throw on a shape surprise ----

        public static Dictionary<string, object> Obj(object o) { return o as Dictionary<string, object>; }
        public static List<object> Arr(object o) { return o as List<object>; }

        public static object Field(object o, string key)
        {
            var d = o as Dictionary<string, object>;
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        public static string Str(object o, string key) { return Field(o, key) as string; }

        //! Tri-state on purpose: a missing field must never read as "false".
        public static bool? Bool(object o, string key)
        {
            object v = Field(o, key);
            return v is bool ? (bool?)(bool)v : null;
        }

        public static double? Number(object o, string key)
        {
            object v = Field(o, key);
            return v is double ? (double?)(double)v : null;
        }
    }

    class RpcResult
    {
        public object Result;
        public string Error;                    // null on success

        /**
         * The JSON-RPC error code, when the node ANSWERED with an error.
         *
         * Null means no code was available - either the call succeeded, or it
         * never reached the node at all. The forwarding code depends on telling
         * those two apart: "answered -5, I have never seen that transaction" is
         * a fact about the chain, while "the socket timed out" is a fact about
         * the network and resolves nothing. Matching on substrings of Error is
         * not good enough in a path that spends money, because the node echoes
         * user input back inside its error text.
         */
        public int? Code;

        /**
         * True when the failure happened below the JSON-RPC layer: no
         * connection, a timeout, an unparseable body. The node did not answer,
         * so nothing may be concluded from it.
         */
        public bool Transport;

        public bool Ok { get { return Error == null; } }
    }

    /**
     * Talks to bitcoind's HTTP RPC on loopback.
     *
     * Credentials come from the datadir's .cookie file, or from rpcuser and
     * rpcpassword in pcoin.conf if the operator configured those instead.
     */
    class RpcClient
    {
        readonly string _datadir;
        string _user, _pass;
        int _port = 9443;                       // PCoin mainnet
        DateTime _authRead = DateTime.MinValue;

        public RpcClient(string datadir)
        {
            _datadir = string.IsNullOrEmpty(datadir) ? DefaultDataDir() : datadir;
        }

        public string DataDir { get { return _datadir; } }

        //! The RPC port in use, for messages that tell somebody what to unblock.
        public int Port { get { LoadAuth(); return _port; } }

        //! Matches GetDefaultDataDir() in src/common/args.cpp.
        public static string DefaultDataDir()
        {
            string roaming = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PCoin");
            if (Directory.Exists(roaming)) return roaming;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PCoin");
        }

        public string ConfPath { get { return Path.Combine(_datadir, "pcoin.conf"); } }

        void LoadAuth()
        {
            // Re-read at most every few seconds, and re-read from scratch: the
            // cookie is rewritten every time bitcoind starts, so caching the
            // first one that worked would break permanently after a restart.
            if ((DateTime.UtcNow - _authRead).TotalSeconds < 5 && _user != null) return;
            _authRead = DateTime.UtcNow;
            _user = null;
            _pass = null;

            string cookieFile = Path.Combine(_datadir, ".cookie");
            try
            {
                if (File.Exists(ConfPath))
                {
                    foreach (var raw in File.ReadAllLines(ConfPath))
                    {
                        string line = raw.Trim();
                        if (line.Length == 0 || line[0] == '#' || line[0] == '[') continue;
                        int eq = line.IndexOf('=');
                        if (eq <= 0) continue;
                        string k = line.Substring(0, eq).Trim();
                        string v = line.Substring(eq + 1).Trim();
                        if (k == "rpcport") { int p; if (int.TryParse(v, out p)) _port = p; }
                        else if (k == "rpcuser") _user = v;
                        else if (k == "rpcpassword") _pass = v;
                        else if (k == "rpccookiefile")
                            cookieFile = Path.IsPathRooted(v) ? v : Path.Combine(_datadir, v);
                    }
                }
            }
            catch { }

            if (_user == null || _pass == null)
            {
                try
                {
                    string cookie = File.ReadAllText(cookieFile);
                    int c = cookie.IndexOf(':');
                    if (c > 0) { _user = cookie.Substring(0, c); _pass = cookie.Substring(c + 1).Trim(); }
                }
                catch { }
            }
        }

        public RpcResult Call(string method, string paramsJson) { return Call(null, method, paramsJson, 20000); }
        public RpcResult Call(string wallet, string method, string paramsJson) { return Call(wallet, method, paramsJson, 20000); }

        /**
         * @param wallet  wallet name for a wallet-scoped endpoint, or null
         * @param paramsJson  the params array, already JSON-encoded, e.g. "[1,\"x\"]"
         */
        public RpcResult Call(string wallet, string method, string paramsJson, int timeoutMs)
        {
            var res = new RpcResult();
            string body = "{\"jsonrpc\":\"1.0\",\"id\":\"pcointray\",\"method\":" + Json.Quote(method) +
                          ",\"params\":" + (paramsJson ?? "[]") + "}";

            string text = Post(wallet, body, timeoutMs, res);
            if (text == null) return res;                // Transport/Error already set

            object parsed;
            try { parsed = Json.Parse(text); }
            catch (Exception ex)
            {
                // A body we cannot read is not an answer either.
                res.Transport = true;
                res.Error = Sanitize(ex.Message);
                return res;
            }
            Fold(parsed, res);
            return res;
        }

        /**
         * Several calls in one HTTP round trip.
         *
         * Used where the alternative is hundreds of sequential loopback trips -
         * `gettransaction` for every distinct txid behind a two-hundred-input
         * sweep. Results come back in the same order as @p methods; a slot the
         * node did not answer carries Transport = true, never a fabricated
         * success, because the caller's default for an unread transaction has
         * to stay the strict one.
         *
         * Core replies to a batch with HTTP 200 and an array of reply objects
         * (src/httprpc.cpp), each carrying back the id it was sent, so results
         * are matched by id rather than by position.
         */
        public List<RpcResult> Batch(string wallet, List<string> methods, List<string> paramsJson, int timeoutMs)
        {
            var results = new List<RpcResult>(methods.Count);
            for (int i = 0; i < methods.Count; i++) results.Add(new RpcResult());
            if (methods.Count == 0) return results;

            var sb = new StringBuilder("[");
            for (int i = 0; i < methods.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"jsonrpc\":\"1.0\",\"id\":")
                  .Append(Json.Quote(i.ToString(CultureInfo.InvariantCulture)))
                  .Append(",\"method\":").Append(Json.Quote(methods[i]))
                  .Append(",\"params\":").Append(paramsJson[i] ?? "[]").Append('}');
            }
            sb.Append(']');

            var transport = new RpcResult();
            string text = Post(wallet, sb.ToString(), timeoutMs, transport);
            if (text == null)
            {
                foreach (var r in results) { r.Transport = transport.Transport; r.Error = transport.Error; }
                return results;
            }

            List<object> arr = null;
            try { arr = Json.Arr(Json.Parse(text)); }
            catch { }
            if (arr == null)
            {
                // Not the shape a batch reply has. Nothing may be read out of
                // it, so every slot stays unanswered.
                foreach (var r in results) { r.Transport = true; r.Error = "the node did not answer the batch"; }
                return results;
            }

            var seen = new bool[results.Count];
            foreach (var item in arr)
            {
                string id = Json.Str(item, "id");
                int slot;
                if (id == null || !int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out slot)) continue;
                if (slot < 0 || slot >= results.Count || seen[slot]) continue;
                seen[slot] = true;
                Fold(item, results[slot]);
            }
            for (int i = 0; i < results.Count; i++)
            {
                if (seen[i]) continue;
                results[i].Transport = true;
                results[i].Error = "the node did not answer this call";
            }
            return results;
        }

        //! Turn one JSON-RPC reply object into a result. An `error` member wins
        //! over `result`, and its code is kept as a number rather than only as
        //! text: callers in the send path branch on it.
        static void Fold(object reply, RpcResult res)
        {
            object err = Json.Field(reply, "error");
            if (err != null)
            {
                string msg = Json.Str(err, "message");
                double? code = Json.Number(err, "code");
                if (code.HasValue) res.Code = (int)code.Value;
                res.Error = Sanitize(msg ?? "the node reported an error") +
                            (code.HasValue ? " (code " + ((int)code.Value).ToString(CultureInfo.InvariantCulture) + ")" : "");
                return;
            }
            res.Result = Json.Field(reply, "result");
        }

        /**
         * POST a body and return the response text, or null with @p res
         * describing why not.
         *
         * An RPC error arrives as HTTP 500 with a JSON body, so a 500 is still
         * a response and its body is still read; only a failure with no
         * response at all is a transport failure.
         */
        string Post(string wallet, string body, int timeoutMs, RpcResult res)
        {
            LoadAuth();
            if (_user == null || _pass == null)
            {
                res.Transport = true;
                res.Error = "cannot read the node's RPC credentials (.cookie) in " + _datadir;
                return null;
            }

            string url = "http://127.0.0.1:" + _port.ToString(CultureInfo.InvariantCulture) + "/";
            if (!string.IsNullOrEmpty(wallet)) url += "wallet/" + Uri.EscapeDataString(wallet);

            byte[] payload = Encoding.UTF8.GetBytes(body);
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Proxy = null;                       // never send a local RPC through a proxy
                req.KeepAlive = false;
                req.Headers["Authorization"] = "Basic " +
                    Convert.ToBase64String(Encoding.UTF8.GetBytes(_user + ":" + _pass));
                req.ContentLength = payload.Length;
                using (var s = req.GetRequestStream()) s.Write(payload, 0, payload.Length);

                try
                {
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    using (var rd = new StreamReader(resp.GetResponseStream()))
                        return rd.ReadToEnd();
                }
                catch (WebException we)
                {
                    if (we.Response == null)
                    {
                        res.Transport = true;
                        res.Error = Sanitize(we.Message);
                        return null;
                    }
                    string errText;
                    using (var rd = new StreamReader(we.Response.GetResponseStream())) errText = rd.ReadToEnd();
                    if (!string.IsNullOrEmpty(errText.Trim())) return errText;

                    // A response with no body at all - an HTTP 401 from bad
                    // credentials is the one that matters - carries no JSON to
                    // read, so name the status instead of failing with a JSON
                    // parse error that says nothing about the cause.
                    res.Transport = true;
                    var http = we.Response as HttpWebResponse;
                    res.Error = http != null
                        ? "HTTP " + ((int)http.StatusCode).ToString(CultureInfo.InvariantCulture) + " " + http.StatusCode
                        : Sanitize(we.Message);
                    return null;
                }
            }
            catch (Exception ex)
            {
                res.Transport = true;
                res.Error = Sanitize(ex.Message);
                return null;
            }
            finally
            {
                Array.Clear(payload, 0, payload.Length);
            }
        }

        /**
         * Strip key material out of anything that might be shown or written
         * down. importdescriptors echoes the offending descriptor back in its
         * error text, so an unsanitised message can contain the account xprv.
         */
        public static string Sanitize(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            s = Regex.Replace(s, "(xprv|tprv)[1-9A-HJ-NP-Za-km-z]+", "<private key redacted>");
            s = Regex.Replace(s, @"wpkh\([^)]*\)", "wpkh(<descriptor redacted>)");
            return s;
        }
    }
}
