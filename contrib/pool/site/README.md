# pool.pc.am landing page

`index.html` is the page served at <https://pool.pc.am/> by Caddy from
`/var/www/pool.pc.am/index.html` on the pool host (`contrib/pool/DESIGN.md`
names it). Until 2026-09-02 the deployed file was the only copy; this is it,
byte for byte, so a change can be reviewed before it is live.

Deploy atomically — stage beside the target and `mv`, then fetch the public URL
back and compare hashes:

```sh
scp index.html root@<pool host>:/var/www/pool.pc.am/.index.html.staging
ssh root@<pool host> 'chown caddy:caddy /var/www/pool.pc.am/.index.html.staging && \
  mv -f /var/www/pool.pc.am/.index.html.staging /var/www/pool.pc.am/index.html'
curl -sL https://pool.pc.am/ | sha256sum; sha256sum index.html
```

The `/api/*` routes on the same hostname are served by `api.mjs`, not by this
file.
