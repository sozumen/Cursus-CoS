"""Writes small Outlook .msg files for the tests (test/fixtures/*.msg). A .msg is a Windows compound file;
this is a minimal writer, checked against olefile and @kenjiuno/msgreader, which read it independently."""
import struct, sys, datetime
SS, MS, CUT = 512, 64, 4096
END, FATSEC, FREE = 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF

def filetime(dt):
    return int((dt - datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)).total_seconds() * 1e7)

def build(streams):
    names = list(streams)
    # mini stream: small streams packed in 64-byte units
    mini, miniFat, loc = bytearray(), [], {}
    for n in names:
        d = streams[n]
        if len(d) < CUT:
            start = len(mini) // MS; k = max(1, -(-len(d) // MS))
            mini += d + b'\0' * (k * MS - len(d))
            for i in range(k): miniFat.append(start + i + 1 if i < k - 1 else END)
            loc[n] = start
    sectors = []   # list of bytes (each SS long)
    def put(data):
        start = len(sectors); k = max(1, -(-len(data) // SS)) if data else 0
        data = data + b'\0' * (k * SS - len(data))
        for i in range(k): sectors.append(data[i * SS:(i + 1) * SS])
        return start, k
    fat = {}
    def chain(start, k):
        for i in range(k): fat[start + i] = start + i + 1 if i < k - 1 else END
    big = {}
    for n in names:
        if len(streams[n]) >= CUT:
            s, k = put(streams[n]); chain(s, k); big[n] = s
    mstart, mk = put(bytes(mini)) if mini else (END, 0)
    if mk: chain(mstart, mk)
    mf = b''.join(struct.pack('<I', x) for x in miniFat)
    mfstart, mfk = put(mf) if mf else (END, 0)
    if mfk: chain(mfstart, mfk)
    # directory
    def ent(name, typ, left, right, child, start, size):
        nb = name.encode('utf-16le') + b'\0\0'
        return nb.ljust(64, b'\0') + struct.pack('<HBBIII', len(nb), typ, 1, left, right, child) + b'\0' * 16 + b'\0' * 4 + b'\0' * 16 + struct.pack('<IQ', start, 0)[:4] + struct.pack('<Q', size)
    ents = [ent('Root Entry', 5, FREE, FREE, 1 if names else FREE, mstart if mk else END, len(mini))]
    for i, n in enumerate(names):
        st = big[n] if n in big else loc[n]
        ents.append(ent(n, 2, FREE, i + 2 if i + 1 < len(names) else FREE, FREE, st, len(streams[n])))
    while len(ents) % 4: ents.append(b'\0' * 128)
    dstart, dk = put(b''.join(ents)); chain(dstart, dk)
    # FAT sectors
    nfat = 1
    while True:
        total = len(sectors) + nfat
        if nfat * 128 >= total: break
        nfat += 1
    fstart = len(sectors)
    for i in range(nfat): fat[fstart + i] = FATSEC
    table = [fat.get(i, FREE) for i in range(nfat * 128)]
    fb = b''.join(struct.pack('<I', x) for x in table)
    for i in range(nfat): sectors.append(fb[i * SS:(i + 1) * SS])
    hdr = bytearray(512)
    hdr[0:8] = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
    struct.pack_into('<HHHHH', hdr, 0x18, 0x3E, 3, 0xFFFE, 9, 6)
    struct.pack_into('<IIIIIIIII', hdr, 0x28, 0, nfat, dstart, 0, CUT, mfstart if mfk else END, mfk, END, 0)
    for i in range(109): struct.pack_into('<I', hdr, 0x4C + i * 4, fstart + i if i < nfat else FREE)
    return bytes(hdr) + b''.join(sectors)

def u16(s): return s.encode('utf-16le') + b'\0\0'

def props(date_dt):
    p = bytearray(32)
    p += struct.pack('<HHIQ', 0x40, 0x0E06, 6, filetime(date_dt))
    p += struct.pack('<HHIQ', 0x40, 0x0039, 6, filetime(date_dt))
    return bytes(p)

def make(path, subject, sender, addr, body, date_dt, ansi=False, msgid=''):
    t = lambda tid, s: ('__substg1.0_%s%s' % (tid, '001E' if ansi else '001F'), s.encode('cp1252') + b'\0' if ansi else u16(s))
    st = dict([t('0037', '\x01\x01' + subject), t('0C1A', sender), t('5D01', addr), t('1000', body), t('1035', msgid)])
    st['__properties_version1.0'] = props(date_dt)
    open(path, 'wb').write(build(st))

if __name__ == '__main__':
    out = sys.argv[1]
    d = datetime.datetime(2026, 10, 14, 15, 30, tzinfo=datetime.timezone.utc)
    make(out + '/mail-unicode.msg', 'Re: Acme quote – final numbers', 'Dana Reyes', 'dana.reyes@acme.example',
         'Hi Jon,\r\n\r\nThe final quote is attached. We can hold the price until Nov 30.\r\n\r\nDana', d, msgid='<abc123@acme.example>')
    make(out + '/mail-ansi-big.msg', 'Weekly status', 'Sam Ortiz', 'sam@northwind.example',
         'Status line.\r\n' * 600, d, ansi=True, msgid='<big1@northwind.example>')
