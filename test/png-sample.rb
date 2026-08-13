#!/usr/bin/env ruby
# 采样 PNG 指定区域像素（调试渲染颜色）
require 'zlib'

def decode_png(path)
  data = File.binread(path)
  idat = +''.b
  w = h = nil
  off = 8
  while off < data.length
    len = data[off, 4].unpack1('N')
    type = data[off + 4, 4]
    chunk = data[off + 8, len]
    if type == 'IHDR' then w, h = chunk.unpack('NN')
    elsif type == 'IDAT' then idat << chunk
    end
    off += 12 + len
  end
  raw = Zlib::Inflate.inflate(idat)
  out = raw.bytes
  stride = w * 4
  rows = []
  prev = [0] * stride
  pos = 0
  h.times do
    f = out[pos]; pos += 1
    row = out[pos, stride]; pos += stride
    stride.times do |i|
      a = i >= 4 ? row[i - 4] : 0
      b = prev[i]
      c = i >= 4 ? prev[i - 4] : 0
      v = row[i]
      row[i] = case f
               when 1 then (v + a) & 0xff
               when 2 then (v + b) & 0xff
               when 3 then (v + ((a + b) >> 1)) & 0xff
               when 4
                 p = a + b - c
                 pa = (p - a).abs; pb = (p - b).abs; pc = (p - c).abs
                 (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
               else v
               end
    end
    rows << row
    prev = row
  end
  [w, h, rows]
end

w, h, rows = decode_png(ARGV[0])
puts "bg(5,5)     = " + rows[5][5 * 4, 4].inspect
puts "bg(600,500) = " + rows[500][600 * 4, 4].inspect
# A 矩阵第 0 行前 8 个单元格中心
puts 'A row0 cells:'
8.times do |c|
  x = (28 + 19.2 * c + 9.6).to_i
  y = (678 + 9.6).to_i
  r = rows[y]
  i = x * 4
  puts format('cell %d: rgba(%d,%d,%d,%d)', c, r[i], r[i + 1], r[i + 2], r[i + 3])
end
# 统计 A 区域内各通道分布
bx = []; bg = []; bb = []
(678..1292).step(4).each do |y|
  r = rows[y]
  (28..642).step(4).each do |x|
    i = x * 4
    next if r[i + 3] < 200
    bx << r[i]; bg << r[i + 1]; bb << r[i + 2]
  end
end
puts "A region: R in #{bx.min}..#{bx.max}, G in #{bg.min}..#{bg.max}, B in #{bb.min}..#{bb.max}"
puts "A region: count b>150: #{bb.count { |v| v > 150 }}, count r>150: #{bx.count { |v| v > 150 }}, total #{bx.size}"
