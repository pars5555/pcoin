// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The one question this app asks about where its blocks go.
//
// Shown once, after auto-tuning has MEASURED what this machine does, and only
// when the arithmetic says solo genuinely suits it. Rules it follows, all of
// them deliberate:
//
//  - it shows the numbers it is arguing from, both of them read at runtime.
//    Nothing here is a stored figure about the network: difficulty moves, and a
//    number a program states as fact is a promise it has to keep.
//  - Enter picks nothing: there is no AcceptButton. The recommended answer is
//    the bold one; the answer keyboard focus rests on is the one that changes
//    nothing, because those are different jobs and only one of them is safe to
//    do by reflex.
//  - Escape, and the X, mean "stay with the pool" -- the mode this machine is
//    already in. A dialog closed without being read must never change anything.
//  - it names no fee percentage. The pool's fee is the pool's to set and this
//    app has no way to read it, so it says the pool takes a fee, which stays
//    true whatever that fee becomes.

using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace PCoinTray
{
    // SoloOfferForm -- the pool-vs-solo modal -- was removed 2026-09-10 on the
    // owner's instruction: "there is option user will select anytime, no need
    // to offer".
    //
    // Do not bring it back. Solo is the default now, so it could only ever have
    // reached someone already on the pool, and its "Stay with the pool" branch
    // made the ~71% pool concentration marginally worse every time it was
    // taken -- concentration being the one thing every exchange conversation
    // dies on. The choice itself was never hidden: the Mining-mode card in the
    // miner window carries both options and a live recommendation line, and it
    // can be changed at any moment.
}
