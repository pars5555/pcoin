# PCoin Wallet — store listing copy

App name (30): **PCoin Wallet**

## Short description (74/80)

Non-custodial PCoin (PCN) wallet that runs a real full node on your phone.

## Full description (1569/4000)

PCoin Wallet is a non-custodial wallet for PCoin (PCN) that runs a genuine full node on your phone. It verifies every block itself, so you do not have to trust any server, exchange or company - not even ours.

YOUR KEYS, YOUR COINS
- Your wallet is created on your phone and protected by your device lock.
- Back up with a standard 12-word recovery phrase. Anyone with the phrase controls the coins; nobody without it can touch them.
- We run no accounts, no cloud and no database. There is nothing to hack on our side, because there is no "our side".

A REAL NODE IN YOUR POCKET
- Connects directly to the PCoin peer-to-peer network and independently verifies the chain.
- The whole PCoin chain is small enough for a phone, so full verification takes minutes, not days.
- Balance and history come from your own node, not from an API.

SEND AND RECEIVE, SIMPLY
- One permanent receive address, shown as a QR code.
- Scan a QR code or paste an address to pay; every send shows the real network fee before you confirm.
- Choose your fee: Normal, Fast or Very fast.
- Name the addresses you pay in a private address book, and export or import it as a file whenever you like.

HONEST BY DESIGN
- The review screen shows the exact transaction that was built - amount, fee, and total - before anything is broadcast.
- No ads, no analytics, no tracking. The camera is used only to scan QR codes.

ABOUT PCOIN
PCoin is an independent proof-of-work blockchain. Learn more at https://pc.am. This wallet is free software; the source is public at https://github.com/pars5555/pcoin.

## Sign in details entry (App content → Sign in details)

Name (43/60): `No account needed - device screen lock only`

Instructions (483/500 — the limit is hard, count before pasting):

```
No accounts, no server, no login - there are no credentials to share.

Open the app, tap CREATE A NEW WALLET, then save or skip the 12-word phrase. The app syncs a PCoin full node (a few minutes); balances stay empty until it finishes. Every screen is then reachable.

The only prompt is the test device's OWN screen lock (PIN/pattern/biometric), asked by Android just before sending. Use the device's own lock. With no lock set, the app says so and everything else stays accessible.
```

Tick "Sign in details in this declaration provide full access to all the
features and content within this app".

## Foreground service justification (Special use)

```
The app runs a full PCoin cryptocurrency node on the device. The service must start immediately and stay running while the user is away: it holds live peer-to-peer connections and continuously validates incoming blockchain data. Pausing or killing the node mid-validation corrupts the local chain state and forces a long resync, during which the wallet cannot show a balance or send funds. No standard foreground service type covers running a peer-to-peer blockchain node, so the special use type is declared.
```

Demo video (unlisted): https://www.youtube.com/watch?v=sY2qV5UdeWs

## Graphics

| Asset | File | Notes |
|---|---|---|
| Icon | `assets/icon-512.png` | 512x512, rendered from `contrib/branding/out/pcoin-wallet.svg` |
| Feature graphic | `assets/feature-graphic.png` | 1024x500 |
| Screenshots | `assets/screenshots/0*.png` | 1080x2140, from the Z Flip 5 |

Screenshots are real captures, cropped from 1080x2640 and with the balance
box blurred. Reused unchanged for the 7-inch and 10-inch tablet slots.

## Contact / settings

- Category: **Finance** · App (not game) · Free
- Email `pcoinpcn@gmail.com` · Website `https://pc.am` · no phone
- Privacy policy `https://pc.am/wallet-privacy.html`
