#!/usr/bin/env python3
"""Install the watchdog on the Linux miners (the systemctl --user layout).

    python deploy-watchdog-linux.py musho pars-mint

Same shape as deploy-watchdog.py: the files travel as write_file request bodies,
then a short shell script installs them and enables the timer. Verification is
by SHA-256 ON THE DEVICE, and the Linux agent writes exactly the bytes it is
given (unlike the Windows one, which adds a UTF-8 BOM), so a plain hash match is
the right check here.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "aicontrol"))
import ac  # noqa: E402

FILES = [("miner-watchdog.sh", "pcoin-watchdog"),
         ("pcoin-watchdog.service", "pcoin-watchdog.service"),
         ("pcoin-watchdog.timer", "pcoin-watchdog.timer")]

INSTALL = """
set -e
cd $HOME
mkdir -p ~/.local/bin ~/.config/systemd/user ~/.local/state
install -m755 ~/miner-watchdog.sh ~/.local/bin/pcoin-watchdog
install -m644 ~/pcoin-watchdog.service ~/pcoin-watchdog.timer ~/.config/systemd/user/
rm -f ~/miner-watchdog.sh ~/pcoin-watchdog.service ~/pcoin-watchdog.timer ~/wd-test.txt
echo 'on-device sha256: '$(sha256sum ~/.local/bin/pcoin-watchdog | cut -d' ' -f1)
systemctl --user daemon-reload
systemctl --user enable --now pcoin-watchdog.timer
echo 'timer: '$(systemctl --user is-active pcoin-watchdog.timer)
systemctl --user list-timers pcoin-watchdog.timer --no-pager | head -2
echo 'dry run:'
bash ~/.local/bin/pcoin-watchdog && echo 'watchdog ran clean'
tail -3 ~/.local/state/pcoin-watchdog.log 2>/dev/null || true
"""


def deploy(device, want):
    dev = ac.resolve(device)
    # Resolve the home directory FIRST: the Linux agent does not expand '~' in a
    # written path, so '~/pcoin-watchdog.sh' lands nowhere and only the install
    # step notices. Absolute paths only.
    home = (ac.call(dev, "run_shell", {"command": "echo $HOME", "timeout_ms": 20000},
                    timeout=60).get("result") or "").strip().splitlines()[-1].strip()
    if not home.startswith("/"):
        print("%-10s cannot resolve $HOME (got %r)" % (device, home))
        return False
    for local, remote in FILES:
        content = open(os.path.join(HERE, local), encoding="utf-8", newline="").read()
        ac.call(dev, "write_file", {"path": home + "/" + local, "content": content}, timeout=120)
    r = ac.call(dev, "run_shell", {"command": INSTALL, "timeout_ms": 90000}, timeout=150)
    out = (r.get("result") or "") if isinstance(r, dict) else str(r)
    ok = want in out and "timer: active" in out and "watchdog ran clean" in out
    print("%-10s %s" % (device, "OK" if ok else "CHECK"))
    for line in out.strip().splitlines():
        print("    " + line.strip()[:150])
    return ok


def main(argv):
    want = hashlib.sha256(
        open(os.path.join(HERE, "miner-watchdog.sh"), "rb").read()).hexdigest()
    devices = argv[1:] or ["musho", "pars-mint", "cachyos"]
    bad = []
    for d in devices:
        try:
            if not deploy(d, want):
                bad.append(d)
        except SystemExit as e:          # ac.resolve/ac.api exit on error
            print("%-10s UNREACHABLE: %s" % (d, str(e)[:90]))
            bad.append(d)
    print("\n%d/%d installed%s" % (len(devices) - len(bad), len(devices),
                                   ("; failed: " + ", ".join(bad)) if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))