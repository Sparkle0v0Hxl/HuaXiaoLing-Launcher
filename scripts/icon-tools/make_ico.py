"""
生成多尺寸 .ico，交给 exe 的 PE 资源使用。

为什么要做这件事：Windows 任务栏上「正在运行的应用」图标，优先用窗口通过
WM_SETICON 设进去的那一张，只有没设才会回落到 exe 的资源图标。Electron 从
单张 PNG 建出来的 nativeImage 只有一个尺寸，任务栏要 24px 时只能把 256 硬缩
下去，缩完是一团糊掉的颜色块，用户根本认不出这是花筱灵。ico 里按档位各存
一份，系统按尺寸精确取用，小尺寸就能保住轮廓。

分档用不同的源图，这是 Windows 图标的常规做法：
  - 小档（16/20/24/32）用 icon-taskbar.png，人物头部特写。全身立绘缩到 24px
    只剩一团粉色，头部特写至少还能看出是张脸。
  - 大档（40 及以上）用 icon.png，完整立绘带品牌字。Alt-Tab、资源管理器大图
    这些地方要的是辨识度和好看，头部特写反而不够。

小档额外两步：先锐化把眉眼和发丝的边界拉回来，再把 alpha 边缘收敛成接近
实心或接近全透明，避免缩图后四周浮出一圈灰边。

为什么手写容器：PIL 的 ICO 保存会忽略 sizes 参数，实测只落 16x16 一档。
所以这里自己拼 ICONDIR + ICONDIRENTRY + 每帧 PNG（Vista 及以上都认这种格式）。
"""

import io
import os
import struct
import sys

from PIL import Image, ImageFilter

SMALL_SRC = sys.argv[1]  # 头部特写，用于小档
LARGE_SRC = sys.argv[2]  # 完整立绘，用于大档
OUT = sys.argv[3]

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SMALL_MAX = 32  # 小于等于这个尺寸用头部特写

small = Image.open(SMALL_SRC).convert('RGBA')
large = Image.open(LARGE_SRC).convert('RGBA')
print('small src:', small.size, ' large src:', large.size)

frames = []
for s in SIZES:
    src = small if s <= SMALL_MAX else large
    im = src.resize((s, s), Image.LANCZOS)
    if s <= 48:
        im = im.filter(ImageFilter.UnsharpMask(radius=0.8, percent=110, threshold=2))
    if s <= 32:
        a = im.getchannel('A')
        a = a.point(lambda v: 0 if v < 96 else (255 if v > 168 else v))
        im.putalpha(a)
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    frames.append((s, buf.getvalue(), 'face' if s <= SMALL_MAX else 'full'))

out = bytearray()
count = len(frames)
out += struct.pack('<HHH', 0, 1, count)

offset = 6 + 16 * count
for s, data, _kind in frames:
    b = 0 if s >= 256 else s  # 256 在目录项里用 0 表示
    out += struct.pack('<BBBBHHII', b, b, 0, 0, 1, 32, len(data), offset)
    offset += len(data)

for _s, data, _kind in frames:
    out += data

with open(OUT, 'wb') as fh:
    fh.write(bytes(out))

print('written:', OUT, os.path.getsize(OUT), 'bytes')
print('sizes:', [(s, k) for s, _d, k in frames])
