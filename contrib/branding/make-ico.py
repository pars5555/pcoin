"""Pack the rendered PNGs into a multi-resolution Windows .ico.

Written by hand rather than via System.Drawing.Icon: GetHicon caps out at a
single 32x32 image, which is what makes an installer icon look like mush on a
150% display. The ICO container has allowed PNG-compressed entries since Vista,
so every size below is stored as the PNG that was already rendered -- no
re-encoding, no resampling, no quality loss.
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SHIP = os.path.join(HERE, 'out')
# The jumbo slot must be EXACTLY 256: the ICO width byte stores 0 to mean
# "256 or larger", so anything bigger is stored under a size it does not have.
# Windows reads the embedded PNG's real dimensions and the two then disagree.
SIZES = [16, 32, 48, 64, 128, 256]


def build(flavour, out):
    entries = []
    for s in SIZES:
        p = os.path.join(SHIP, 'pcoin-%s-%d.png' % (flavour, s))
        if not os.path.isfile(p):
            raise SystemExit('missing render: %s' % p)
        with open(p, 'rb') as f:
            entries.append((s, f.read()))

    # ICONDIR: reserved=0, type=1 (icon), count
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_bytes = b''
    data_bytes = b''
    for s, blob in entries:
        # 0 in the width/height byte means 256 or larger.
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        dir_bytes += struct.pack('<BBBBHHII',
                                 w, h,
                                 0,      # palette count, 0 for truecolour
                                 0,      # reserved
                                 1,      # colour planes
                                 32,     # bits per pixel
                                 len(blob),
                                 offset)
        data_bytes += blob
        offset += len(blob)

    with open(out, 'wb') as f:
        f.write(header + dir_bytes + data_bytes)

    total = os.path.getsize(out)
    print('  %-26s %d sizes %s  %6d B' %
          (os.path.basename(out), len(entries),
           '/'.join(str(s) for s in SIZES), total))
    return out


def verify(path):
    """Re-read the container and confirm every entry is a real PNG."""
    with open(path, 'rb') as f:
        blob = f.read()
    reserved, typ, count = struct.unpack('<HHH', blob[:6])
    assert reserved == 0 and typ == 1, 'not an icon file'
    ok = []
    for i in range(count):
        off = 6 + 16 * i
        w, h, _pal, _res, planes, bpp, size, data_off = struct.unpack('<BBBBHHII', blob[off:off + 16])
        chunk = blob[data_off:data_off + size]
        is_png = chunk[:8] == b'\x89PNG\r\n\x1a\n'
        real_w = int.from_bytes(chunk[16:20], 'big') if is_png else None
        ok.append((w or 256, real_w, is_png, bpp))
    print('    entries:', ', '.join(
        '%dpx%s' % (declared, '' if (is_png and real == declared) else ' MISMATCH')
        for declared, real, is_png, _ in ok))
    bad = [e for e in ok if not e[2] or e[1] != e[0]]
    print('    all PNG, all sizes agree:', not bad)
    return not bad


print('Windows .ico:')
tray = os.path.join(SHIP, 'pcoin.ico')
build('miner', tray)
verify(tray)

wallet = os.path.join(SHIP, 'pcoin-wallet.ico')
build('wallet', wallet)
verify(wallet)

# The tray app and installer live in the repo, so the icon ships beside them.
dest = os.path.join(HERE, os.pardir, 'windows-tray', 'pcoin.ico')
with open(tray, 'rb') as a, open(dest, 'wb') as b:
    b.write(a.read())
print('\ncopied to %s' % dest)
