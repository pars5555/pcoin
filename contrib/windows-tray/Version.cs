// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The one place the tray's own version is written down.
//
// It has to exist somewhere the RUNNING app can read, because "is there a newer
// version than me?" cannot be answered without knowing what "me" is -- and the
// exe's FileVersion is 0.0.0.0 (csc stamps nothing, and this project builds with
// csc directly rather than through a project file that would).
//
// The obvious hazard is that this goes stale and the app cheerfully reports
// itself up to date forever. So pack-win64.py REFUSES to build a zip whose
// --version disagrees with this constant. A check that only warns is not a
// check (CLAUDE.md Â§7.12); this one stops the release.

namespace PCoinTray
{
    static class Build
    {
        //! Bump together with install.ps1's $Version and the release tag.
        //! pack-win64.py will not let you forget.
        public const string Version = "1.4.24";
    }
}
