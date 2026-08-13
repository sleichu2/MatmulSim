#!/usr/bin/env ruby
# ============================================================
# render-svg.rb — 本地 SVG→PNG 渲染器（Ruby Fiddle + CoreGraphics/CoreText）
# 用于无浏览器环境下的人工视觉验证:
#   ruby test/render-svg.rb test/shots/02-playing.svg out.png [scale]
# 支持: rect/path(M L Q A Z)/text/g(translate scale)/颜色/透明度/虚线
# ============================================================
require 'fiddle/import'
require 'rexml/document'

module CG
  extend Fiddle::Importer
  dlload '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

  extern 'void* CGColorSpaceCreateDeviceRGB()'
  extern 'void* CGBitmapContextCreate(void*, long, long, long, long, void*, int)'
  extern 'void* CGBitmapContextCreateImage(void*)'
  extern 'void CGContextSaveGState(void*)'
  extern 'void CGContextRestoreGState(void*)'
  extern 'void CGContextTranslateCTM(void*, double, double)'
  extern 'void CGContextScaleCTM(void*, double, double)'
  extern 'void CGContextSetRGBFillColor(void*, double, double, double, double)'
  extern 'void CGContextSetRGBStrokeColor(void*, double, double, double, double)'
  extern 'void CGContextSetLineWidth(void*, double)'
  extern 'void CGContextSetAlpha(void*, double)'
  extern 'void CGContextSetLineDash(void*, double, double*, long)'
  extern 'void CGContextBeginPath(void*)'
  extern 'void CGContextMoveToPoint(void*, double, double)'
  extern 'void CGContextAddLineToPoint(void*, double, double)'
  extern 'void CGContextAddQuadCurveToPoint(void*, double, double, double, double)'
  extern 'void CGContextAddCurveToPoint(void*, double, double, double, double, double, double)'
  extern 'void CGContextClosePath(void*)'
  extern 'void CGContextFillPath(void*)'
  extern 'void CGContextStrokePath(void*)'
  extern 'void CGContextSetTextPosition(void*, double, double)'
end

module CF
  extend Fiddle::Importer
  dlload '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

  extern 'void* CFStringCreateWithCString(void*, char*, int)'
  extern 'void* CFAttributedStringCreate(void*, void*, void*)'
  extern 'void* CFDictionaryCreateMutable(void*, long, void*, void*)'
  extern 'void CFDictionarySetValue(void*, void*, void*)'
  extern 'void* CFDataCreateMutable(void*, long)'
  extern 'void* CFDataGetBytePtr(void*)'
  extern 'long CFDataGetLength(void*)'
  extern 'void CFRelease(void*)'
end

module CT
  extend Fiddle::Importer
  dlload '/System/Library/Frameworks/CoreText.framework/CoreText'

  extern 'void* CTFontCreateWithName(void*, double, void*)'
  extern 'void* CTLineCreateWithAttributedString(void*)'
  extern 'void CTLineDraw(void*, void*)'
  extern 'double CTLineGetTypographicBounds(void*, double*, double*, double*)'
end

module IIO
  extend Fiddle::Importer
  dlload '/System/Library/Frameworks/ImageIO.framework/ImageIO'

  extern 'void* CGImageDestinationCreateWithData(void*, void*, long, void*)'
  extern 'void CGImageDestinationAddImage(void*, void*, void*)'
  extern 'int CGImageDestinationFinalize(void*)'
end

class Fiddle::Pointer
  def hex
    '0x%x' % to_i
  end
end

UTF8 = 0x08000100 # kCFStringEncodingUTF8
NUL = Fiddle::Pointer[0]

def cfstr(s)
  CF.send(:CFStringCreateWithCString, NUL, s.b, UTF8)
end

# 颜色解析 → [r,g,b,a] (0..1)
def parse_color(c)
  return [0, 0, 0, 1] unless c
  c = c.strip
  if (m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.match(c))
    r, g, b = m[1].scan(/../).map { |x| x.to_i(16) / 255.0 }
    a = m[2] ? m[2].to_i(16) / 255.0 : 1.0
    return [r, g, b, a]
  end
  if (m = /^rgba?\(([^)]+)\)$/.match(c))
    v = m[1].split(/[,\s]+/).reject(&:empty?).map(&:to_f)
    return [v[0] / 255.0, v[1] / 255.0, v[2] / 255.0, v[3] || 1.0]
  end
  [0, 0, 0, 1]
end

class Renderer
  def initialize(w, h, scale)
    @scale = scale
    @W = (w * scale).to_i
    @H = (h * scale).to_i
    cs = CG.send(:CGColorSpaceCreateDeviceRGB)
    @ctx = CG.send(:CGBitmapContextCreate, nil, @W, @H, 8, @W * 4, cs, 1) # premultipliedLast
    # y 轴翻转 → 与 SVG 坐标一致
    CG.send(:CGContextTranslateCTM, @ctx, 0, @H)
    CG.send(:CGContextScaleCTM, @ctx, scale, -scale)
    @font_cache = {}
  end

  def draw_rect(attrs, fill: true)
    x = attrs['x'].to_f * 1; y = attrs['y'].to_f * 1
    w = attrs['width'].to_f; h = attrs['height'].to_f
    return if w <= 0 || h <= 0
    CG.send(:CGContextBeginPath, @ctx)
    CG.send(:CGContextMoveToPoint, @ctx, x, y)
    CG.send(:CGContextAddLineToPoint, @ctx, x + w, y)
    CG.send(:CGContextAddLineToPoint, @ctx, x + w, y + h)
    CG.send(:CGContextAddLineToPoint, @ctx, x, y + h)
    CG.send(:CGContextClosePath, @ctx)
    if fill && attrs['fill'] != 'none'
      r, g, b, a = parse_color(attrs['fill'])
      apply_opacity(a, attrs)
      CG.send(:CGContextSetRGBFillColor, @ctx, r, g, b, 1)
      CG.send(:CGContextFillPath, @ctx)
    end
    unless attrs['stroke'] == 'none' || !attrs['stroke']
      r, g, b, a = parse_color(attrs['stroke'])
      apply_opacity(a, attrs)
      CG.send(:CGContextSetRGBStrokeColor, @ctx, r, g, b, 1)
      CG.send(:CGContextSetLineWidth, @ctx, (attrs['stroke-width'] || '1').to_f)
      set_dash(attrs)
      CG.send(:CGContextStrokePath, @ctx)
    end
  end

  def draw_path(attrs, fill:)
    d = attrs['d'].to_s
    CG.send(:CGContextBeginPath, @ctx)
    seg = d.scan(/[MLQACZmlqacz]|[-\d.eE+]+/)
    i = 0
    while i < seg.length
      tok = seg[i]
      case tok
      when 'M', 'm'
        CG.send(:CGContextMoveToPoint, @ctx, seg[i + 1].to_f, seg[i + 2].to_f); i += 3
      when 'L', 'l'
        CG.send(:CGContextAddLineToPoint, @ctx, seg[i + 1].to_f, seg[i + 2].to_f); i += 3
      when 'Q', 'q'
        CG.send(:CGContextAddQuadCurveToPoint, @ctx, seg[i + 1].to_f, seg[i + 2].to_f, seg[i + 3].to_f, seg[i + 4].to_f); i += 5
      when 'C', 'c'
        CG.send(:CGContextAddCurveToPoint, @ctx, seg[i + 1].to_f, seg[i + 2].to_f, seg[i + 3].to_f, seg[i + 4].to_f, seg[i + 5].to_f, seg[i + 6].to_f); i += 7
      when 'A', 'a'
        # 椭圆弧 → 32 段折线近似
        rx = seg[i + 1].to_f; ry = seg[i + 2].to_f; rot = seg[i + 3].to_f * Math::PI / 180
        laf = seg[i + 4].to_i; sf = seg[i + 5].to_i
        x1 = seg[i + 6].to_f; y1 = seg[i + 7].to_f
        # 获取当前点近似（用上次目标）
        x0 = @cx || 0; y0 = @cy || 0
        a0 = sf.zero? ? 0 : Math::PI * 2
        # 全圆简化（本工程弧仅用于点标记）
        33.times do |k|
          t = a0 + (a0.zero? ? 2 * Math::PI * k / 32 : 2 * Math::PI * (1 - k / 32.0))
          x = x1 + rx * Math.cos(t)
          y = y1 + ry * Math.sin(t)
          k.zero? ? CG.send(:CGContextMoveToPoint, @ctx, x, y) : CG.send(:CGContextAddLineToPoint, @ctx, x, y)
        end
        @cx, @cy = x1, y1
        i += 8
      when 'Z', 'z'
        CG.send(:CGContextClosePath, @ctx); i += 1
      else
        i += 1
      end
    end
    if fill && attrs['fill'] != 'none'
      r, g, b, a = parse_color(attrs['fill'])
      apply_opacity(a, attrs)
      CG.send(:CGContextSetRGBFillColor, @ctx, r, g, b, 1)
      CG.send(:CGContextFillPath, @ctx)
    else
      r, g, b, a = parse_color(attrs['stroke'])
      apply_opacity(a, attrs)
      CG.send(:CGContextSetRGBStrokeColor, @ctx, r, g, b, 1)
      CG.send(:CGContextSetLineWidth, @ctx, (attrs['stroke-width'] || '1').to_f)
      set_dash(attrs)
      CG.send(:CGContextStrokePath, @ctx)
    end
  end

  def draw_text(el)
    attrs = el.attributes
    x = attrs['x'].to_f; y = attrs['y'].to_f
    size = (attrs['font-size'] || '10').to_f
    family = (attrs['font-family'] || 'Helvetica').split(',').first
    r, g, b, a = parse_color(attrs['fill'])
    apply_opacity(a, attrs)
    CG.send(:CGContextSetRGBFillColor, @ctx, r, g, b, 1)
    key = [family, size]
    font = @font_cache[key] ||= begin
      CT.send(:CTFontCreateWithName, cfstr(family.gsub('"', '')), size, NUL)
    end
    dict = CF.send(:CFDictionaryCreateMutable, NUL, 0, NUL, NUL)
    CF.send(:CFDictionarySetValue, dict, cfstr('NSFont'), font)
    attr = CF.send(:CFAttributedStringCreate, NUL, cfstr(el.text.to_s), dict)
    line = CT.send(:CTLineCreateWithAttributedString, attr)
    asc = Fiddle::Pointer.malloc(8); desc = Fiddle::Pointer.malloc(8); lead = Fiddle::Pointer.malloc(8)
    width = CT.send(:CTLineGetTypographicBounds, line, asc, desc, lead)
    ascent = asc[0, 8].unpack1('d'); descent = desc[0, 8].unpack1('d')
    case attrs['text-anchor']
    when 'middle' then x -= width / 2
    when 'end' then x -= width
    end
    case attrs['dominant-baseline']
    when 'central' then y += (ascent - descent) / 2
    when 'hanging' then y -= ascent
    when 'middle' then y += (ascent - descent) / 2
    end
    CG.send(:CGContextSetTextPosition, @ctx, x, y)
    CT.send(:CTLineDraw, line, @ctx)
  end

  def apply_opacity(a, attrs)
    a *= (attrs['opacity'] || '1').to_f
    a *= (attrs['fill-opacity'] || '1').to_f
    CG.send(:CGContextSetAlpha, @ctx, a.clamp(0, 1))
  end

  def set_dash(attrs)
    d = attrs['stroke-dasharray']
    if d && d != 'none'
      arr = d.split(/[ ,]+/).map(&:to_f)
      ptr = Fiddle::Pointer.malloc(arr.length * 8)
      arr.each_with_index { |v, i| ptr[i * 8, 8] = [v].pack('d') }
      CG.send(:CGContextSetLineDash, @ctx, (attrs['stroke-dashoffset'] || '0').to_f, ptr, arr.length)
    else
      CG.send(:CGContextSetLineDash, @ctx, 0, Fiddle::Pointer[0], 0)
    end
  end

  def render(node, t_x = 0, t_y = 0, t_sx = 1, t_sy = 1)
    node.elements.each do |el|
      case el.name
      when 'rect'
        draw_rect(el.attributes)
      when 'path'
        fill = el.attributes['fill'] != 'none'
        draw_path(el.attributes, fill: fill)
      when 'text'
        draw_text(el)
      when 'g'
        tr = el.attributes['transform'].to_s
        dx = dy = 0; sx = sy = 1
        if (m = /translate\(([-\d.]+),([-\d.]+)\)/.match(tr))
          dx = m[1].to_f; dy = m[2].to_f
        end
        if (m = /scale\(([-\d.]+),([-\d.]+)\)/.match(tr))
          sx = m[1].to_f; sy = m[2].to_f
        end
        CG.send(:CGContextSaveGState, @ctx)
        CG.send(:CGContextTranslateCTM, @ctx, dx, dy)
        CG.send(:CGContextScaleCTM, @ctx, sx, sy)
        render(el, dx, dy, sx, sy)
        CG.send(:CGContextRestoreGState, @ctx)
      end
    end
  end

  def save(path)
    img = CG.send(:CGBitmapContextCreateImage, @ctx)
    data = CF.send(:CFDataCreateMutable, NUL, 0)
    dest = IIO.send(:CGImageDestinationCreateWithData, data, cfstr('public.png'), 1, NUL)
    IIO.send(:CGImageDestinationAddImage, dest, img, NUL)
    IIO.send(:CGImageDestinationFinalize, dest)
    len = CF.send(:CFDataGetLength, data)
    ptr = CF.send(:CFDataGetBytePtr, data)
    # 注意: Pointer#to_s 按 strlen 截断（PNG 内大量 NUL 字节），必须用定长读取
    bytes = Fiddle::Pointer.new(ptr, len)[0, len]
    File.binwrite(path, bytes)
    puts "written #{path} (#{@W}x#{@H})"
  end
end

svg_path = ARGV[0] or abort 'usage: ruby render-svg.rb in.svg out.png [scale]'
out_path = ARGV[1] or abort 'usage: ruby render-svg.rb in.svg out.png [scale]'
scale = (ARGV[2] || 2).to_f
doc = REXML::Document.new(File.read(svg_path))
svg = doc.root
w = svg.attributes['width'].to_f
h = svg.attributes['height'].to_f
r = Renderer.new(w, h, scale)
r.render(svg)
r.save(out_path)
