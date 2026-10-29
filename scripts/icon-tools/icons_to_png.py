import struct, os, sys
from PIL import Image

outdir = sys.argv[1]
outpng = sys.argv[2]

# RT_ICON blob = BITMAPINFOHEADER(biHeight doubled) + XOR (BGRA) + AND mask(1bpp)
def blob_to_image(blob):
    # Vista+ allows PNG-compressed icon entries
    if blob[:8] == b'\x89PNG\r\n\x1a\n':
        import io
        return Image.open(io.BytesIO(blob)).convert('RGBA')
    biSize, w, h, planes, bpp, comp, sizeImage = struct.unpack_from('<IiiHHII', blob, 0)
    real_h = h // 2
    header = struct.pack('<IiiHHIIiiII', biSize, w, real_h, planes, bpp, comp, sizeImage, 0, 0, 0, 0)
    # locate pixel data
    off = biSize
    # color masks may follow if biCompression==3 (BI_BITFIELDS)
    if comp == 3:
        off += 12
    xor_size = ((w * bpp + 31) // 32) * 4 * real_h
    xor = blob[off:off + xor_size]
    and_off = off + xor_size
    row_bytes = ((w + 31) // 32) * 4
    and_size = row_bytes * real_h
    andmask = blob[and_off:and_off + and_size]
    # build BMP in memory: BITMAPFILEHEADER + header + xor + and
    bmp = b'BM' + struct.pack('<IHHI', 14 + biSize + xor_size + and_size, 0, 0, 14 + biSize) + header + xor + andmask
    import io
    img = Image.open(io.BytesIO(bmp))
    return img.convert('RGBA')

tiles = []
files = sorted([f for f in os.listdir(outdir) if f.endswith('.bin')],
               key=lambda f: int(f.split('_')[1].split('.')[0]))
for f in files:
    blob = open(os.path.join(outdir, f), 'rb').read()
    img = blob_to_image(blob)
    tiles.append((f, img))

# grid canvas
cell = 260
cols = 4
rows = (len(tiles) + cols - 1) // cols
canvas = Image.new('RGBA', (cols * cell, rows * (cell + 20)), (40, 40, 46, 255))
for i, (f, img) in enumerate(tiles):
    r, c = divmod(i, cols)
    im = img.copy()
    im.thumbnail((cell - 8, cell - 8), Image.LANCZOS)
    canvas.paste(im, (c * cell + 4, r * (cell + 20) + 4), im)
canvas.save(outpng)
print('saved', outpng)
for f, img in tiles:
    print(f, img.size)
