#!/usr/bin/env ruby
# ============================================================
# png-check.rb — PNG 解码 + 区域像素统计（纯 stdlib，无依赖）
# 客观验证各截图的关键视觉元素是否出现在预期位置
# 用法: ruby test/png-check.rb
# ============================================================
require 'zlib'

def decode_png(path)
  data = File.binread(path)
  raise 'not png' unless data[0, 8] == "\x89PNG\r\n\x1a\n".b
  idat = +''.b
  w = h = bitdepth = colortype = nil
  off = 8
  while off < data.length
    len = data[off, 4].unpack1('N')
    type = data[off + 4, 4]
    chunk = data[off + 8, len]
    case type
    when 'IHDR'
      w, h, bitdepth, colortype = chunk.unpack('NNCC')
    when 'IDAT'
      idat << chunk
    end
    off += 12 + len
  end
  raw = Zlib::Inflate.inflate(idat)
  bpp = colortype == 6 ? 4 : colortype == 2 ? 3 : 1
  stride = w * bpp
  out = raw.bytes
  # noop
  rows = []
  prev = [0] * stride
  pos = 0
  paeth = ->(a, b, c) {
    p = a + b - c; pa = (p - a).abs; pb = (p - b).abs; pc = (p - c).abs
    (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
  }
  h.times do
    f = out[pos]; pos += 1
    row = out[pos, stride]; pos += stride
    stride.times do |i|
      a = i >= bpp ? row[i - bpp] : 0
      b = prev[i]
      c = i >= bpp ? prev[i - bpp] : 0
      v = row[i]
      case f
      when 0 then row[i] = v
      when 1 then row[i] = (v + a) & 0xff
      when 2 then row[i] = (v + b) & 0xff
      when 3 then row[i] = (v + ((a + b) >> 1)) & 0xff
      when 4 then row[i] = (v + paeth.call(a, b, c)) & 0xff
      end
    end
    rows << row
    prev = row
  end
  [w, h, rows]
end

# 区域统计
def count_in(rows, x0, y0, x1, y1, pred)
  n = 0
  (y0...y1).each do |y|
    r = rows[y] or next
    (x0...x1).step(1).each do |x|
      i = x * 4
      n += 1 if pred.call(r[i], r[i + 1], r[i + 2], r[i + 3])
    end
  end
  n
end

def frac_colored(rows, x0, y0, x1, y1)
  total = (x1 - x0) * (y1 - y0)
  colored = count_in(rows, x0, y0, x1, y1, ->(r, g, b, a) { a > 200 && (r + g + b) > 90 && !(r > 15 && r < 25 && g > 20 && g < 32 && b > 30 && b < 45) })
  [colored, total, colored.to_f / total]
end

def blueish
  ->(r, g, b, a) { a > 200 && b > 140 && b > r + 40 && g < b }
end
def orangeish
  ->(r, g, b, a) { a > 200 && r > 160 && g > 60 && g < 190 && b < 120 && r > b + 60 }
end
def cyan
  ->(r, g, b, a) { a > 200 && b > 230 && g > 130 && r < 130 && g > r + 30 }
end
def green
  ->(r, g, b, a) { a > 200 && g > 140 && r < 120 && b < 130 }
end
def amber
  ->(r, g, b, a) { a > 200 && r > 100 && g > 60 && b < 130 && r > b + 40 && g > b + 15 }
end
def magenta
  ->(r, g, b, a) { a > 200 && r > 160 && b > 180 && g < 160 && r > 120 }
end

fails = 0
def check(name, cond, detail = '')
  if cond then puts "  \u2713 #{name}"
  else puts "  \u2717 #{name}  #{detail}"; end
end

# 主画布几何（1180×660 逻辑 @2x）
s = 2
ax0 = (14 * s); ay0 = (339 * s); aw = (307 * s)
bx0 = (339 * s); by0 = (14 * s); bw = (307 * s)
cx0 = (339 * s); cy0 = (339 * s)

puts '=== 02-playing.png (播放中主画布) ==='
w, h, rows = decode_png('/tmp/mmvis-test/02-playing.png')
check('尺寸 2360×1320', w == 2360 && h == 1320, "#{w}x#{h}")
blue_n = count_in(rows, ax0, ay0, ax0 + aw, ay0 + aw, blueish)
orange_n = count_in(rows, ax0, ay0, ax0 + aw, ay0 + aw, orangeish)
check('A 区域有蓝/橙数值格', blue_n > 800 && orange_n > 800, "blue=#{blue_n} orange=#{orange_n}")
b_blue = count_in(rows, bx0, by0, bx0 + bw, by0 + bw, blueish)
b_orange = count_in(rows, bx0, by0, bx0 + bw, by0 + bw, orangeish)
check('B 区域有蓝/橙数值格', b_blue > 800 && b_orange > 800, "blue=#{b_blue} orange=#{b_orange}")
c_colored, c_total, c_frac = frac_colored(rows, cx0, cy0, cx0 + bw, cy0 + bw)
check('C 区域部分填充(0<frac<1)', c_frac > 0.05 && c_frac < 0.98, "#{(c_frac * 100).round(1)}%")
cyan_n = count_in(rows, 0, 0, w, h, cyan)
check('青色 L2 面板框存在', cyan_n > 200, cyan_n)
mag_n = count_in(rows, 0, 0, w, h, magenta)
check('品红微块框存在', mag_n > 200, mag_n)
amb_n = count_in(rows, ax0, ay0, ax0 + aw, ay0 + aw, amber)
check('A 区域有琥珀 k 亮线', amb_n > 60, amb_n)
inset, _, inset_frac = frac_colored(rows, (14 * s), (14 * s), (14 * s + 380), (14 * s + 240))
check('左上角微内核面板有内容', inset_frac > 0.08, "#{(inset_frac * 100).round(1)}%")
hud_n = count_in(rows, (10 * s), (640 * s), (1170 * s), (658 * s), ->(r, g, b, a) { a > 60 && (r + g + b) > 120 })
check('底部 HUD 文字存在', hud_n > 100, hud_n)

puts '=== 03-done.png (播放结束) ==='
w, h, rows = decode_png('/tmp/mmvis-test/03-done.png')
_, _, c_frac = frac_colored(rows, cx0, cy0, cx0 + bw, cy0 + bw)
check('C 区域基本填满', c_frac > 0.75, "#{(c_frac * 100).round(1)}%")

puts '=== 02-mem.png (内存层次) ==='
w, h, rows = decode_png('/tmp/mmvis-test/02-mem.png')
blue_chip = count_in(rows, 0, 0, w, h, ->(r, g, b, a) { a > 200 && b > 190 && r < 140 && r > 60 && g < 190 && g > 90 })
green_chip = count_in(rows, 0, 0, w, h, green)
check('存在蓝/绿色驻留块', blue_chip > 300 && green_chip > 300, "blue=#{blue_chip} green=#{green_chip}")
dr_cyan = count_in(rows, 0, 0, w, h, cyan)
check('存在青色块(DRAM/L2)', dr_cyan > 100, dr_cyan)
txt_n = count_in(rows, 0, 0, w, h, ->(r, g, b, a) { a > 200 && r > 120 && g > 120 && b > 120 && (r + g + b) > 480 })
check('有浅色文字', txt_n > 500, txt_n)

puts '=== 03-roofline.png (Roofline) ==='
w, h, rows = decode_png('/tmp/mmvis-test/03-roofline.png')
ridge = count_in(rows, 0, 0, w, h, cyan)
green_n = count_in(rows, 0, 0, w, h, green)
red_pt = count_in(rows, 0, 0, w, h, ->(r, g, b, a) { a > 200 && r > 200 && g < 100 && b < 100 })
white_pt = count_in(rows, 0, 0, w, h, ->(r, g, b, a) { a > 200 && r > 220 && g > 220 && b > 220 })
check('带宽墙(蓝)存在', ridge > 300, ridge)
check('峰值墙(绿)存在', green_n > 200, green_n)
check('无分块(红)/实际回放(白)点存在', red_pt > 5 && white_pt > 5, "red=#{red_pt} white=#{white_pt}")

puts '=== 06-large.png (96×96 大型) ==='
w, h, rows = decode_png('/tmp/mmvis-test/06-large.png')
_, _, a_frac = frac_colored(rows, ax0, ay0, ax0 + aw, ay0 + aw)
_, _, c_frac = frac_colored(rows, cx0, cy0, cx0 + bw, cy0 + bw)
check('大型 A/C 区域基本填满', a_frac > 0.6 && c_frac > 0.6, "A=#{(a_frac * 100).round(1)}% C=#{(c_frac * 100).round(1)}%")
cyan_n = count_in(rows, 0, 0, w, h, cyan)
check('大型仍有青色面板框', cyan_n > 200, cyan_n)

exit(fails)
