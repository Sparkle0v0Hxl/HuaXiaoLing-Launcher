import struct, sys, os

def u16(b, o): return struct.unpack_from('<H', b, o)[0]
def u32(b, o): return struct.unpack_from('<I', b, o)[0]

def parse_pe(path):
    data = open(path, 'rb').read()
    e_lfanew = u32(data, 0x3C)
    assert data[e_lfanew:e_lfanew+4] == b'PE\0\0', 'not PE'
    coff = e_lfanew + 4
    nsec = u16(data, coff + 2)
    size_opt = u16(data, coff + 16)
    opt = coff + 20
    magic = u16(data, opt)
    if magic == 0x10B:
        dd_off = opt + 96
    else:
        dd_off = opt + 112
    # data directories
    ndd = u32(data, dd_off - 4 + 0) if False else None
    # section table
    sec_off = opt + size_opt
    sections = []
    for i in range(nsec):
        s = sec_off + i * 40
        name = data[s:s+8].rstrip(b'\0')
        vsize = u32(data, s+8); vaddr = u32(data, s+12)
        rsize = u32(data, s+16); raddr = u32(data, s+20)
        sections.append((name, vaddr, vsize, raddr, rsize))
    # resource data dir = index 2
    res_rva = u32(data, dd_off + 2*8)
    res_size = u32(data, dd_off + 2*8 + 4)
    return data, sections, res_rva, res_size

def rva_to_off(sections, rva):
    for name, vaddr, vsize, raddr, rsize in sections:
        if vaddr <= rva < vaddr + max(vsize, rsize):
            return raddr + (rva - vaddr)
    return None

def walk(data, sections, off, base, depth=0, path=()):
    """yield (path, rva, size) for leaf entries"""
    named = u16(data, off+12); idn = u16(data, off+14)
    total = named + idn
    out = []
    for i in range(total):
        e = off + 16 + i*8
        name_field = u32(data, e)
        off_field = u32(data, e+4)
        is_dir = bool(off_field & 0x80000000)
        sub = off_field & 0x7FFFFFFF
        key = name_field if (name_field & 0x80000000) else name_field
        if is_dir:
            out.extend(walk(data, sections, base + sub, base, depth+1, path + (('N',key) if (name_field & 0x80000000) else ('I',key),)))
        else:
            dentry = base + off_field
            rva = u32(data, dentry)
            size = u32(data, dentry+4)
            out.append((path + (('N',key) if (name_field & 0x80000000) else ('I',key),), rva, size))
    return out

def main(exe, outdir):
    data, sections, res_rva, res_size = parse_pe(exe)
    base = rva_to_off(sections, res_rva)
    leaves = walk(data, sections, base, base)
    os.makedirs(outdir, exist_ok=True)
    icons = [l for l in leaves if l[0][0] == ('I', 3)]   # RT_ICON
    groups = [l for l in leaves if l[0][0] == ('I', 14)]  # RT_GROUP_ICON
    print('RT_ICON count:', len(icons))
    print('RT_GROUP_ICON count:', len(groups))
    from collections import Counter
    print('resource types present:', sorted(Counter(l[0][0][1] for l in leaves).items()))
    # dump RT_GROUP_ICON info
    for p, rva, size in groups:
        o = rva_to_off(sections, rva)
        resvd, typ, count = struct.unpack_from('<HHH', data, o)
        entries = []
        for i in range(count):
            w, h, cc, resv, planes, bpp, bsz, id_ = struct.unpack_from('<BBBBHHII', data, o+6+i*14)
            entries.append((w if w else 256, h if h else 256, bpp, bsz, id_))
        print('group', p, 'entries:')
        for e in entries:
            print('   ', e)
    # dump each RT_ICON
    saved = []
    for p, rva, size in icons:
        o = rva_to_off(sections, rva)
        blob = data[o:o+size]
        rid = p[1][1]
        fn = os.path.join(outdir, 'icon_%d.bin' % rid)
        open(fn, 'wb').write(blob)
        saved.append((rid, size, fn))
    print('dumped', len(saved), 'icon blobs to', outdir)
    for rid, size, fn in sorted(saved):
        print('  id=%d size=%d' % (rid, size))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
