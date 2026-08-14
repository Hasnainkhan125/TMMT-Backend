"""
Morning Ritual — Premium Brand Guidelines Book Generator
Produces a print-ready PDF with watercolor aesthetics, paper grain,
and dawn-inspired colour palette.
"""

import math
import random
import io
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, inch
from reportlab.lib.colors import HexColor, Color, white, black
from reportlab.pdfgen import canvas
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# ── Brand Palette ──────────────────────────────────────────────────────────────
CREAM        = HexColor("#F9F7F3")
DEEP_BROWN   = HexColor("#5F4738")
WARM_BROWN   = HexColor("#8B7355")
DARK_ROAST   = HexColor("#2C1810")
TERRACOTTA   = HexColor("#C4714A")
BEIGE        = HexColor("#D4B896")
LIGHT_BEIGE  = HexColor("#EDE8DF")
SAGE         = HexColor("#8A9B78")
MIST         = HexColor("#B8C4B8")
GOLD         = HexColor("#C9A96E")
WARM_WHITE   = HexColor("#FDFBF8")

W, H = A4  # 595 x 842 pt

# ── Helpers ────────────────────────────────────────────────────────────────────

def grain(c, x, y, w, h, density=0.18, seed=42):
    """Simulate paper grain with tiny semi-transparent dots."""
    rng = random.Random(seed)
    c.saveState()
    c.setFillColor(Color(0.35, 0.25, 0.18, alpha=0.045))
    for _ in range(int(w * h * density)):
        px = x + rng.uniform(0, w)
        py = y + rng.uniform(0, h)
        r  = rng.uniform(0.3, 1.1)
        c.circle(px, py, r, fill=1, stroke=0)
    c.restoreState()


def watercolor_blob(c, cx, cy, radius, color: HexColor, layers=6, seed=None):
    """Paint a soft watercolor-style blob."""
    rng = random.Random(seed or int(cx * cy))
    c.saveState()
    r, g, b = color.red, color.green, color.blue
    for i in range(layers):
        alpha = 0.04 + 0.03 * (layers - i) / layers
        scale = 1.0 - 0.06 * i
        cx2   = cx + rng.uniform(-radius * 0.08, radius * 0.08)
        cy2   = cy + rng.uniform(-radius * 0.08, radius * 0.08)
        c.setFillColor(Color(r, g, b, alpha=alpha))
        c.setStrokeColor(Color(r, g, b, alpha=0))
        pts = 24
        path = c.beginPath()
        for p in range(pts + 1):
            angle = 2 * math.pi * p / pts
            dist  = scale * radius * (1 + rng.uniform(-0.08, 0.08))
            px    = cx2 + dist * math.cos(angle)
            py    = cy2 + dist * math.sin(angle)
            if p == 0:
                path.moveTo(px, py)
            else:
                path.lineTo(px, py)
        path.close()
        c.drawPath(path, fill=1, stroke=0)
    c.restoreState()


def dawn_background(c, seed=0):
    """Full-page dawn sky background with cream base + watercolor blobs."""
    c.setFillColor(CREAM)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    blobs = [
        (W * 0.12, H * 0.85, 95,  BEIGE,       seed + 1),
        (W * 0.80, H * 0.90, 120, LIGHT_BEIGE, seed + 2),
        (W * 0.55, H * 0.72, 80,  MIST,        seed + 3),
        (W * 0.20, H * 0.40, 110, BEIGE,       seed + 4),
        (W * 0.85, H * 0.55, 90,  LIGHT_BEIGE, seed + 5),
        (W * 0.45, H * 0.20, 130, MIST,        seed + 6),
        (W * 0.70, H * 0.30, 75,  BEIGE,       seed + 7),
    ]
    for bx, by, br, col, s in blobs:
        watercolor_blob(c, bx, by, br, col, layers=8, seed=s)

    grain(c, 0, 0, W, H, density=0.12, seed=seed + 99)


def section_divider(c, y, color=WARM_BROWN):
    """Thin organic line divider."""
    c.saveState()
    rng = random.Random(int(y))
    c.setStrokeColor(Color(color.red, color.green, color.blue, alpha=0.35))
    c.setLineWidth(0.6)
    path = c.beginPath()
    path.moveTo(40 * mm, y)
    x_pos = 40 * mm
    while x_pos < W - 40 * mm:
        x_pos += rng.uniform(4, 12)
        dy = rng.uniform(-1, 1)
        path.lineTo(x_pos, y + dy)
    c.drawPath(path, stroke=1, fill=0)
    c.restoreState()


def page_number(c, num, total=47):
    c.saveState()
    c.setFont("Helvetica", 7)
    c.setFillColor(Color(WARM_BROWN.red, WARM_BROWN.green, WARM_BROWN.blue, alpha=0.55))
    c.drawCentredString(W / 2, 12 * mm, f"Morning Ritual  ·  {num}")
    c.restoreState()


def draw_logo_mark(c, cx, cy, size=28, color=DEEP_BROWN):
    """Simple geometric cup silhouette as logo mark."""
    c.saveState()
    c.setFillColor(color)
    c.setStrokeColor(color)
    # Cup body
    c.setLineWidth(2)
    body = c.beginPath()
    body.moveTo(cx - size * 0.45, cy + size * 0.35)
    body.lineTo(cx - size * 0.35, cy - size * 0.45)
    body.lineTo(cx + size * 0.35, cy - size * 0.45)
    body.lineTo(cx + size * 0.45, cy + size * 0.35)
    body.close()
    c.drawPath(body, fill=1, stroke=0)
    # Handle
    c.setFillColor(CREAM)
    c.setLineWidth(1.5)
    c.arc(cx + size * 0.35, cy - size * 0.1,
          cx + size * 0.75, cy + size * 0.25,
          startAng=270, extent=180)
    # Steam lines
    c.setStrokeColor(color)
    c.setLineWidth(1.2)
    for ox in [-size * 0.15, 0, size * 0.15]:
        c.bezier(cx + ox, cy + size * 0.42,
                 cx + ox - 4, cy + size * 0.62,
                 cx + ox + 4, cy + size * 0.78,
                 cx + ox,     cy + size * 0.95)
    c.restoreState()


def heading(c, text, x, y, size=22, color=DEEP_BROWN, font="Times-Bold", align="left"):
    c.saveState()
    c.setFillColor(color)
    c.setFont(font, size)
    if align == "center":
        c.drawCentredString(x, y, text)
    elif align == "right":
        c.drawRightString(x, y, text)
    else:
        c.drawString(x, y, text)
    c.restoreState()


def body_text(c, text, x, y, width, size=9.5, color=DARK_ROAST, leading=15):
    """Wrapped body text using Paragraph."""
    style = ParagraphStyle(
        "body",
        fontName="Times-Roman",
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=TA_JUSTIFY,
    )
    p = Paragraph(text, style)
    p.wrapOn(c, width, 999)
    p.drawOn(c, x, y - p.height)
    return p.height


def colour_swatch(c, x, y, w, h, hex_color, label, sub=""):
    col = HexColor(hex_color)
    c.setFillColor(col)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=0)
    # Subtle shadow
    c.setFillColor(Color(0, 0, 0, alpha=0.08))
    c.roundRect(x + 1.5, y - 1.5, w, h, 4, fill=1, stroke=0)
    c.setFillColor(col)
    c.roundRect(x, y, w, h, 4, fill=1, stroke=0)
    # Text
    lum = 0.299 * col.red + 0.587 * col.green + 0.114 * col.blue
    txt = white if lum < 0.55 else DARK_ROAST
    c.setFillColor(txt)
    c.setFont("Times-Bold", 8)
    c.drawString(x + 6, y + h - 16, label)
    c.setFont("Helvetica", 7)
    c.drawString(x + 6, y + 7, hex_color)
    if sub:
        c.setFont("Helvetica-Oblique", 6.5)
        c.drawString(x + 6, y + 17, sub)


def type_specimen(c, x, y, label, font, size, sample, color=DARK_ROAST):
    c.setFillColor(Color(WARM_BROWN.red, WARM_BROWN.green, WARM_BROWN.blue, alpha=0.55))
    c.setFont("Helvetica", 7.5)
    c.drawString(x, y + 4, label)
    c.setFillColor(color)
    c.setFont(font, size)
    c.drawString(x, y - size, sample)
    section_divider(c, y - size - 6)


# ── Pages ──────────────────────────────────────────────────────────────────────

def cover_page(c):
    c.setFillColor(DARK_ROAST)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # Background blobs in dark mode
    for bx, by, br, col, s in [
        (W * 0.15, H * 0.80, 130, HexColor("#3D2415"), 10),
        (W * 0.85, H * 0.85, 160, HexColor("#4A2E1A"), 11),
        (W * 0.50, H * 0.50, 110, HexColor("#3A2010"), 12),
        (W * 0.25, H * 0.20, 100, HexColor("#3D2415"), 13),
        (W * 0.80, H * 0.25, 120, HexColor("#4A2E1A"), 14),
    ]:
        watercolor_blob(c, bx, by, br, col, layers=10, seed=s)

    grain(c, 0, 0, W, H, density=0.10, seed=55)

    # Thin gold rule top
    c.setStrokeColor(Color(GOLD.red, GOLD.green, GOLD.blue, alpha=0.5))
    c.setLineWidth(0.5)
    c.line(30 * mm, H - 22 * mm, W - 30 * mm, H - 22 * mm)

    # Logo mark
    draw_logo_mark(c, W / 2, H * 0.62, size=38, color=GOLD)

    # Brand name
    c.setFillColor(CREAM)
    c.setFont("Times-Bold", 42)
    c.drawCentredString(W / 2, H * 0.50, "Morning Ritual")

    c.setFillColor(Color(BEIGE.red, BEIGE.green, BEIGE.blue, alpha=0.75))
    c.setFont("Helvetica", 11)
    c.drawCentredString(W / 2, H * 0.455, "B R A N D   G U I D E L I N E S")

    # Edition line
    c.setFillColor(Color(GOLD.red, GOLD.green, GOLD.blue, alpha=0.7))
    c.setFont("Helvetica", 8)
    c.drawCentredString(W / 2, H * 0.40, "2 0 2 5   E D I T I O N")

    # Bottom rule + address
    c.setStrokeColor(Color(GOLD.red, GOLD.green, GOLD.blue, alpha=0.4))
    c.line(30 * mm, 28 * mm, W - 30 * mm, 28 * mm)
    c.setFillColor(Color(BEIGE.red, BEIGE.green, BEIGE.blue, alpha=0.55))
    c.setFont("Helvetica", 7.5)
    c.drawCentredString(W / 2, 21 * mm, "125 Hudson Street, New York, NY 10013  ·  morningritualnyc.com")


def toc_page(c):
    dawn_background(c, seed=20)
    page_number(c, "Table of Contents")

    heading(c, "Table of Contents", 32 * mm, H - 32 * mm, size=28)
    section_divider(c, H - 38 * mm)

    entries = [
        ("Brand Identity Elements",          7),
        ("Values",                            8),
        ("Logo",                              9),
        ("Logo Guidelines",                  10),
        ("Tagline",                          11),
        ("Logo Usage",                       12),
        ("Imagery",                          13),
        ("Sponsorship",                      19),
        ("Colours",                          20),
        ("Typography",                       21),
        ("Writing Guide",                    22),
        ("Email Closing",                    23),
        ("Stationery",                       24),
        ("Application of Services",          25),
        ("Image Usage",                      26),
        ("Symbols",                          31),
        ("Signage",                          32),
        ("Clothing",                         34),
        ("Banners",                          35),
        ("Branch Elements",                  36),
        ("Entrance",                         37),
        ("Showroom",                         38),
        ("Showroom Image Usage",             39),
        ("Delivery Area",                    41),
        ("Workshop",                         42),
        ("Brand-Independent Workshop",       43),
        ("Waiting Area",                     44),
        ("Office Space",                     45),
        ("Restroom",                         46),
        ("Lighting Strip",                   47),
        ("Outdoor Area",                     48),
    ]

    col1 = entries[:16]
    col2 = entries[16:]
    col_x = [32 * mm, W / 2 + 4 * mm]
    start_y = H - 50 * mm
    row_h = 13.5

    for ci, col in enumerate([col1, col2]):
        for i, (title, pg) in enumerate(col):
            y = start_y - i * row_h
            c.setFillColor(Color(WARM_BROWN.red, WARM_BROWN.green, WARM_BROWN.blue, alpha=0.85))
            c.setFont("Times-Roman", 9)
            c.drawString(col_x[ci], y, title)
            # dotted leader
            c.setFont("Helvetica", 8)
            c.setFillColor(Color(WARM_BROWN.red, WARM_BROWN.green, WARM_BROWN.blue, alpha=0.35))
            tx = col_x[ci] + c.stringWidth(title, "Times-Roman", 9) + 4
            ex = col_x[ci] + (W / 2 - 38 * mm if ci == 0 else W - 38 * mm - col_x[ci]) - 16
            dots = int((ex - tx) / 4)
            for d in range(dots):
                c.drawString(tx + d * 4, y, ".")
            c.setFillColor(DEEP_BROWN)
            c.setFont("Times-Bold", 9)
            c.drawRightString(
                col_x[ci] + (W / 2 - 38 * mm if ci == 0 else W - 38 * mm - col_x[ci]),
                y, str(pg)
            )


def section_intro_page(c, pg_num, section, subtitle, body, seed=0):
    dawn_background(c, seed=seed)
    page_number(c, pg_num)

    # Side accent bar
    c.setFillColor(Color(TERRACOTTA.red, TERRACOTTA.green, TERRACOTTA.blue, alpha=0.22))
    c.rect(0, 0, 8 * mm, H, fill=1, stroke=0)

    # Page number badge
    c.setFillColor(DEEP_BROWN)
    c.roundRect(15 * mm, H - 30 * mm, 18 * mm, 10 * mm, 3, fill=1, stroke=0)
    c.setFillColor(CREAM)
    c.setFont("Helvetica-Bold", 8)
    c.drawCentredString(24 * mm, H - 25 * mm, f"Pg {pg_num}")

    heading(c, section, 32 * mm, H - 35 * mm, size=26)
    section_divider(c, H - 40 * mm)

    c.setFont("Times-Italic", 12)
    c.setFillColor(TERRACOTTA)
    c.drawString(32 * mm, H - 50 * mm, subtitle)

    body_text(c, body, 32 * mm, H - 62 * mm, W - 64 * mm, size=9.5)


def brand_identity_page(c):
    dawn_background(c, seed=1)
    page_number(c, 7)

    heading(c, "Brand Identity Elements", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    c.setFont("Times-Italic", 11)
    c.setFillColor(TERRACOTTA)
    c.drawString(32 * mm, H - 50 * mm, "The essence of every cup we serve.")

    elements = [
        ("Mission",      "To create a space where the ritual of morning becomes a cherished moment — thoughtfully crafted coffee, warm hospitality, and a sanctuary for the start of every day."),
        ("Vision",       "To become New York's most beloved morning destination, where quality, community, and craft converge at the intersection of Hudson Street and everyday life."),
        ("Position",     "Morning Ritual occupies the premium-artisan tier — above fast-casual, below fine-dining. We serve those who view their morning coffee as an intentional act, not a transaction."),
        ("Personality",  "Warm. Thoughtful. Unhurried. Rooted. We are the steady hand behind the morning. Our voice is gentle but confident, our aesthetic handcrafted but precise."),
    ]

    y = H - 68 * mm
    for title, txt in elements:
        # Card
        c.setFillColor(Color(WARM_WHITE.red, WARM_WHITE.green, WARM_WHITE.blue, alpha=0.7))
        c.roundRect(30 * mm, y - 30 * mm, W - 60 * mm, 33 * mm, 5, fill=1, stroke=0)
        c.setFillColor(TERRACOTTA)
        c.roundRect(30 * mm, y + 1 * mm, 28 * mm, 8 * mm, 3, fill=1, stroke=0)
        c.setFillColor(CREAM)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawCentredString(44 * mm, y + 4 * mm, title.upper())
        body_text(c, txt, 33 * mm, y - 4 * mm, W - 66 * mm, size=9)
        y -= 36 * mm


def values_page(c):
    dawn_background(c, seed=2)
    page_number(c, 8)

    heading(c, "Our Values", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    values = [
        ("01  Craft",        DEEP_BROWN,   "Every beverage is prepared with intention. We source single-origin beans, calibrate each grind, and treat the brewing process as a practice — not a production line."),
        ("02  Community",    WARM_BROWN,   "Morning Ritual is a neighbourhood anchor. We partner with local suppliers, support nearby creatives, and foster a space that belongs to the people of Hudson Street."),
        ("03  Ritual",       TERRACOTTA,   "We believe in the power of repetition. The same barista, the same corner seat, the same first sip — these small consistencies build meaning over time."),
        ("04  Transparency", SAGE,         "From bean to cup, we share the story behind what you drink. Our suppliers are named, our practices are open, and our pricing reflects real cost — not margin theatre."),
        ("05  Stillness",    GOLD,         "In a city that runs on urgency, we offer permission to pause. Our space, pacing, and service are designed to give you back the first ten minutes of your day."),
    ]

    y = H - 52 * mm
    for val, col, txt in values:
        watercolor_blob(c, 43 * mm, y - 6 * mm, 20, col, layers=5, seed=hash(val) % 1000)
        c.setFillColor(col)
        c.setFont("Times-Bold", 11)
        c.drawString(32 * mm, y, val)
        body_text(c, txt, 32 * mm, y - 5 * mm, W - 64 * mm, size=8.8, leading=13)
        section_divider(c, y - 20 * mm, color=col)
        y -= 30 * mm


def logo_page(c):
    dawn_background(c, seed=3)
    page_number(c, 9)

    heading(c, "The Logo", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    # Primary logo on cream card
    c.setFillColor(Color(WARM_WHITE.red, WARM_WHITE.green, WARM_WHITE.blue, alpha=0.85))
    c.roundRect(40 * mm, H * 0.40, W - 80 * mm, H * 0.25, 8, fill=1, stroke=0)
    draw_logo_mark(c, W / 2, H * 0.575, size=34, color=DEEP_BROWN)
    c.setFillColor(DEEP_BROWN)
    c.setFont("Times-Bold", 28)
    c.drawCentredString(W / 2, H * 0.475, "Morning Ritual")
    c.setFont("Helvetica", 9)
    c.setFillColor(WARM_BROWN)
    c.drawCentredString(W / 2, H * 0.445, "C O F F E E   ·   N E W   Y O R K")

    # Dark variant
    c.setFillColor(DARK_ROAST)
    c.roundRect(40 * mm, H * 0.12, (W - 80 * mm) / 2 - 4 * mm, H * 0.23, 8, fill=1, stroke=0)
    draw_logo_mark(c, 40 * mm + (W - 80 * mm) / 4, H * 0.27, size=22, color=GOLD)
    c.setFillColor(CREAM)
    c.setFont("Times-Bold", 14)
    c.drawCentredString(40 * mm + (W - 80 * mm) / 4, H * 0.185, "Morning Ritual")

    # Reversed variant
    c.setFillColor(TERRACOTTA)
    c.roundRect(W / 2 + 4 * mm, H * 0.12, (W - 80 * mm) / 2 - 4 * mm, H * 0.23, 8, fill=1, stroke=0)
    draw_logo_mark(c, W / 2 + 4 * mm + (W - 80 * mm) / 4, H * 0.27, size=22, color=CREAM)
    c.setFillColor(CREAM)
    c.setFont("Times-Bold", 14)
    c.drawCentredString(W / 2 + 4 * mm + (W - 80 * mm) / 4, H * 0.185, "Morning Ritual")

    c.setFillColor(WARM_BROWN)
    c.setFont("Helvetica", 7.5)
    c.drawCentredString(40 * mm + (W - 80 * mm) / 4,     H * 0.15, "Dark Variant")
    c.drawCentredString(W / 2 + 4 * mm + (W - 80 * mm) / 4, H * 0.15, "Terracotta Variant")

    body_text(c, "The Morning Ritual wordmark is set in a classical serif drawn from the tradition of hand-pressed letterforms. The cup icon abstraction references steam, warmth, and the ritual of preparation. Both elements may be used together or independently according to the usage guidelines on the following pages.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)


def logo_guidelines_page(c):
    dawn_background(c, seed=4)
    page_number(c, 10)

    heading(c, "Logo Guidelines", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    rules = [
        ("Minimum Size",   "The full wordmark must never be reproduced smaller than 28mm wide in print or 80px wide on screen. The icon alone may be used down to 12mm / 36px."),
        ("Clear Space",    "Maintain a clear zone equal to the cap-height of the letter 'M' on all sides of the logo. No other graphic elements, text, or imagery may intrude on this zone."),
        ("Colour Usage",   "Use the Deep Brown (#5F4738) version on light backgrounds. Use the Cream (#F9F7F3) or Gold (#C9A96E) version on dark backgrounds. Never render in gradients or patterns."),
        ("Prohibited",     "Do not stretch, skew, rotate, add drop shadows, recolour, rearrange elements, or apply effects to the logo. Do not place the logo on a busy photographic background without a protective holding shape."),
        ("File Formats",   "Use vector formats (SVG, EPS, PDF) for all print applications. Use PNG with transparent background for digital. Never use a JPEG for the logo."),
    ]

    y = H - 52 * mm
    for i, (title, txt) in enumerate(rules):
        n_color = [DEEP_BROWN, TERRACOTTA, WARM_BROWN, SAGE, GOLD][i]
        c.setFillColor(n_color)
        c.circle(33 * mm, y + 1 * mm, 3.5, fill=1, stroke=0)
        c.setFont("Times-Bold", 10.5)
        c.drawString(38 * mm, y, title)
        body_text(c, txt, 38 * mm, y - 3 * mm, W - 70 * mm, size=8.8, leading=13)
        y -= 28 * mm


def tagline_page(c):
    dawn_background(c, seed=5)
    page_number(c, 11)

    heading(c, "Tagline", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    # Hero tagline
    watercolor_blob(c, W / 2, H * 0.60, 160, BEIGE, layers=10, seed=50)
    c.setFillColor(DEEP_BROWN)
    c.setFont("Times-Italic", 32)
    c.drawCentredString(W / 2, H * 0.595, "\u201cThe first sip of the day.\u201d")
    section_divider(c, H * 0.555)

    c.setFont("Times-Italic", 18)
    c.setFillColor(WARM_BROWN)
    c.drawCentredString(W / 2, H * 0.505, "Secondary: \u201cRitual over rush.\u201d")

    body_text(c, "Our tagline captures the essence of what we offer: a deliberate, sensory beginning. It should appear in sentence case, set in Times Italic, never in all-caps. The tagline may be used independently on packaging, signage, and marketing materials.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)

    c.setFillColor(LIGHT_BEIGE)
    c.roundRect(32 * mm, H * 0.28, W - 64 * mm, 36 * mm, 6, fill=1, stroke=0)
    c.setFillColor(TERRACOTTA)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(36 * mm, H * 0.31 + 22 * mm, "USAGE GUIDANCE")
    body_text(c, "Always italicise. Set at no smaller than 12pt in print or 16px on screen. Pair with a minimum of 12pt breathing room from other text elements. Do not translate; the tagline is always in English.", 36 * mm, H * 0.31 + 17 * mm, W - 72 * mm, size=9)


def logo_usage_page(c):
    section_intro_page(c, 12, "Logo Usage", "Approved applications and pairings.",
        "The logo may be paired with the tagline, address, or social handle beneath the wordmark, centred, using Helvetica Light at 7–8pt. When used with a partner brand or sponsor, separate with a thin vertical rule and maintain equal visual weight. The icon mark alone is approved for use on packaging closures, stamps, embossing, and social media avatars. Always refer to the supplied vector originals and do not recreate the logo by hand or from memory.",
        seed=6)


def imagery_page(c):
    dawn_background(c, seed=7)
    page_number(c, 13)

    heading(c, "Imagery", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    body_text(c, "Morning Ritual imagery is warm, unhurried, and detail-oriented. Every photograph should feel like a memory from a slow morning — the steam lifting from a cup, the grain of a wooden counter, hands wrapped around ceramic. We never use stock photography. All images are commissioned or curated to align with our editorial standards below.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)

    principles = [
        ("Lighting",    "Natural, directional morning light. Avoid flash, harsh shadows, or overly bright exposure. A slight warm tone is preferred."),
        ("Palette",     "Images should echo our brand palette — creams, warm browns, the occasional terracotta accent. Avoid cool-toned or desaturated photography."),
        ("Subjects",    "Coffee in preparation and in rest. Hands, surfaces, textures. The space itself. People in quiet moments. Avoid posed, performative, or stock-style imagery."),
        ("Composition", "Generous whitespace. Asymmetric, editorial framing. Leave room for text overlay where applicable."),
        ("Editing",     "Minimal post-processing. Slight film grain is encouraged. Avoid vignettes, heavy filters, or HDR effects."),
    ]

    y = H - 72 * mm
    for title, txt in principles:
        c.setFillColor(Color(WARM_BROWN.red, WARM_BROWN.green, WARM_BROWN.blue, alpha=0.15))
        c.roundRect(30 * mm, y - 14 * mm, W - 60 * mm, 18 * mm, 4, fill=1, stroke=0)
        c.setFillColor(DEEP_BROWN)
        c.setFont("Times-Bold", 9.5)
        c.drawString(35 * mm, y, title)
        c.setFont("Times-Roman", 9)
        c.setFillColor(DARK_ROAST)
        c.drawString(35 * mm + c.stringWidth(title + "  ", "Times-Bold", 9.5), y, txt)
        y -= 21 * mm


def placeholder_section(c, pg_num, title, subtitle, notes, seed=0):
    """Generic section page for sections without detailed copy."""
    dawn_background(c, seed=seed)
    page_number(c, pg_num)

    c.setFillColor(Color(TERRACOTTA.red, TERRACOTTA.green, TERRACOTTA.blue, alpha=0.22))
    c.rect(0, 0, 8 * mm, H, fill=1, stroke=0)

    heading(c, title, 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    c.setFont("Times-Italic", 11)
    c.setFillColor(TERRACOTTA)
    c.drawString(32 * mm, H - 50 * mm, subtitle)

    y = H - 62 * mm
    for i, (label, note) in enumerate(notes):
        wc = [DEEP_BROWN, WARM_BROWN, TERRACOTTA, SAGE, GOLD]
        watercolor_blob(c, 36 * mm, y + 2 * mm, 12, wc[i % 5], layers=5, seed=seed + i)
        c.setFillColor(wc[i % 5])
        c.setFont("Times-Bold", 10)
        c.drawString(32 * mm, y, label)
        h = body_text(c, note, 32 * mm, y - 4 * mm, W - 64 * mm, size=9, leading=14)
        section_divider(c, y - h - 8 * mm, color=wc[i % 5])
        y -= h + 20 * mm
        if y < 30 * mm:
            break


def colours_page(c):
    dawn_background(c, seed=20)
    page_number(c, 20)

    heading(c, "Colours", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    body_text(c, "Our palette draws from the earliest light of a New York morning — creams, warm earth tones, and the soft glow of dawn through a café window. Use these colours consistently to build recognition and trust.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)

    swatches = [
        ("#2C1810", "Dark Roast",    "Primary text"),
        ("#5F4738", "Deep Brown",    "Logo, headings"),
        ("#8B7355", "Warm Brown",    "Secondary text"),
        ("#C4714A", "Terracotta",    "Accent, CTA"),
        ("#C9A96E", "Gold",          "Premium, print"),
        ("#D4B896", "Beige",         "Backgrounds"),
        ("#F9F7F3", "Cream",         "Page base"),
        ("#8A9B78", "Sage",          "Supporting"),
    ]

    sw_w = (W - 64 * mm) / 4 - 3 * mm
    sw_h = 38 * mm
    for i, (hex_c, name, use) in enumerate(swatches):
        col = i % 4
        row = i // 4
        x = 32 * mm + col * (sw_w + 4 * mm)
        y = H * 0.30 - row * (sw_h + 5 * mm)
        colour_swatch(c, x, y, sw_w, sw_h, hex_c, name, use)


def typography_page(c):
    dawn_background(c, seed=21)
    page_number(c, 21)

    heading(c, "Typography", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    body_text(c, "Our type system pairs the warmth of classical serif letterforms with the precision of a clean humanist sans-serif. Together they create a voice that is both trusted and contemporary.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)

    specimens = [
        ("Display — Times Bold",       "Times-Bold",    30, "Morning Ritual"),
        ("Heading — Times Bold",       "Times-Bold",    18, "The Art of the Morning"),
        ("Subheading — Times Italic",  "Times-Italic",  13, "A ritual worth keeping"),
        ("Body — Times Roman",         "Times-Roman",   10, "We source, roast, and serve with intention."),
        ("Caption — Helvetica",        "Helvetica",      8, "125 Hudson Street · New York · morningritualnyc.com"),
        ("Label — Helvetica Bold",     "Helvetica-Bold", 8, "SINGLE ORIGIN  ·  SEASONAL  ·  SMALL BATCH"),
    ]

    y = H - 65 * mm
    for label, font, size, sample in specimens:
        type_specimen(c, 32 * mm, y, label, font, size, sample)
        y -= size + 18


def writing_guide_page(c):
    placeholder_section(c, 22, "Writing Guide", "Voice, tone, and language standards.",
    [
        ("Voice",      "Write as a knowledgeable friend who happens to know everything about great coffee — warm, informative, never condescending. Use the second person (you/your). Avoid industry jargon unless educating."),
        ("Tone",       "Calm and confident in marketing. Friendly and concise in-store. Empathetic and prompt in customer communications. Never urgent, pushy, or promotional in the discount-driven sense."),
        ("Grammar",    "Use sentence case for headings. Oxford comma always. Em dashes over semicolons. Minimise exclamation marks. Spell out numbers under ten."),
        ("Names",      "Always 'Morning Ritual' — never abbreviated to 'MR'. Products use lowercase: 'oat flat white', not 'Oat Flat White'."),
    ], seed=22)


def email_closing_page(c):
    dawn_background(c, seed=23)
    page_number(c, 23)

    heading(c, "Email Closing", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    c.setFillColor(Color(WARM_WHITE.red, WARM_WHITE.green, WARM_WHITE.blue, alpha=0.8))
    c.roundRect(32 * mm, H * 0.38, W - 64 * mm, H * 0.30, 8, fill=1, stroke=0)

    lines = [
        ("With warmth,", "Times-Italic", 13, DEEP_BROWN),
        ("",             "Helvetica",    9,  DARK_ROAST),
        ("[Your Name]",  "Times-Bold",   11, DEEP_BROWN),
        ("Morning Ritual", "Helvetica",  9,  WARM_BROWN),
        ("125 Hudson Street, New York, NY 10013", "Helvetica", 8, WARM_BROWN),
        ("morningritualnyc.com", "Helvetica", 8, TERRACOTTA),
    ]

    y = H * 0.64
    for text, font, size, color in lines:
        c.setFillColor(color)
        c.setFont(font, size)
        c.drawString(40 * mm, y, text)
        y -= size + 5

    body_text(c, "All outgoing email should use this closing signature. The sign-off should always be 'With warmth,' — never 'Best,' 'Regards,' or 'Cheers.' Font size 10pt in Times New Roman for the name, 9pt Helvetica for contact details. No decorative dividers or large logos in email signatures.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)


def stationery_page(c):
    placeholder_section(c, 24, "Stationery", "Letterhead, business card, and envelope standards.",
    [
        ("Letterhead",     "Use Cream (#F9F7F3) stock minimum 120gsm. Logo top-left at 38mm wide. Address footer in Helvetica 7.5pt, Warm Brown, centred. Top rule in Gold at 0.5pt."),
        ("Business Card",  "3.5\" × 2\" on 32pt soft-touch cardstock. Front: name and title in Times Bold/Italic. Back: logo centred on Deep Brown background with Gold rule borders. Bleed: 3mm."),
        ("Envelope",       "DL or C5 format, Cream stock. Return address back flap only. Logo watermark on inner envelope face at 15% opacity. No window envelopes for branded correspondence."),
        ("Stamp",          "Custom wax seal or rubber stamp using the cup icon mark only, in Deep Brown or Terracotta ink."),
    ], seed=24)


def applications_page(c):
    placeholder_section(c, 25, "Application of Services", "How brand elements apply across our offering.",
    [
        ("Espresso Bar",    "Menu board in hand-lettered chalk on dark panels. Item names in sentence case. Origin notes in Helvetica 7pt beneath each item. Price in Times Bold, right-aligned."),
        ("Retail Bags",     "Kraft brown bags with custom stamp. Sticker seal using cup icon mark. 'Morning Ritual' in Times Bold beneath icon. Roast date and origin on reverse."),
        ("Takeaway Cups",   "Single-colour Deep Brown print on natural kraft sleeve. Logo mark + wordmark. Optional seasonal illustration in Terracotta for limited editions."),
        ("Digital Menu",    "Screen menu mirrors print: dark background, Cream text, Gold accents. Rotate three slides max. No animations. Update seasonally."),
    ], seed=25)


def image_usage_page(c):
    placeholder_section(c, 26, "Image Usage", "Licensing, attribution, and application rules.",
    [
        ("Ownership",      "All photography commissioned for Morning Ritual is owned exclusively by the brand. Images may not be licensed to third parties without written consent."),
        ("Attribution",    "Staff and freelance photographers should be credited in internal records. Social posts may optionally credit the photographer using @handle in caption."),
        ("Cropping",       "Never crop the logo, cup, or barista hands in a way that removes meaning. Maintain subject dignity in all people photography."),
        ("File Standards", "Master files stored as TIFF or RAW minimum 300 DPI. Social exports at 72 DPI minimum 1080px. Always archive the original unedited file."),
    ], seed=26)


def symbols_page(c):
    dawn_background(c, seed=31)
    page_number(c, 31)

    heading(c, "Symbols", 32 * mm, H - 35 * mm, size=24)
    section_divider(c, H - 40 * mm)

    body_text(c, "The following secondary symbols complement the primary logo system. They may be used as ornamental elements, stamps, embossed details, or digital iconography. Never replace the primary logo with a symbol in formal contexts.", 32 * mm, H - 52 * mm, W - 64 * mm, size=9)

    symbols = [
        ("Cup Mark",    lambda cx, cy: draw_logo_mark(c, cx, cy, 26, DEEP_BROWN)),
        ("Circle Ring", lambda cx, cy: (c.setStrokeColor(WARM_BROWN), c.setLineWidth(1.5), c.setFillColor(Color(0,0,0,0)), c.circle(cx, cy, 24, fill=0, stroke=1))),
        ("Dot Rule",    lambda cx, cy: [c.setFillColor(TERRACOTTA) or c.circle(cx + (j-3)*10, cy, 2.5, fill=1, stroke=0) for j in range(7)]),
        ("Serif Star",  lambda cx, cy: (c.setFillColor(GOLD), [c.setFont("Times-Bold", 18) or c.drawCentredString(cx, cy - 7, "✦") for _ in [1]])),
    ]

    box_w = (W - 64 * mm) / 4 - 3 * mm
    for i, (name, draw_fn) in enumerate(symbols):
        x = 32 * mm + i * (box_w + 4 * mm)
        y = H * 0.50
        c.setFillColor(Color(WARM_WHITE.red, WARM_WHITE.green, WARM_WHITE.blue, alpha=0.7))
        c.roundRect(x, y - box_w * 0.5, box_w, box_w, 5, fill=1, stroke=0)
        draw_fn(x + box_w / 2, y + box_w * 0.15)
        c.setFillColor(WARM_BROWN)
        c.setFont("Helvetica", 7.5)
        c.drawCentredString(x + box_w / 2, y - box_w * 0.5 - 8, name)


def signage_page(c):
    placeholder_section(c, 32, "Signage", "Exterior and interior sign specifications.",
    [
        ("Exterior Fascia",  "Backlit channel lettering in Cream on Deep Brown panel. Minimum letter height 120mm. Logo mark to the left of wordmark. Illumination: warm white 2700K LED."),
        ("Window Lettering", "Gold vinyl cut lettering: name, hours, and website. Use Helvetica for supporting information. Tagline may be applied as a secondary window element."),
        ("Interior Menus",   "Chalkboard surface preferred. White chalk for items, gold marker for category headers. Maintain same type hierarchy as print menus."),
        ("Wayfinding",       "Restrooms and exits in Helvetica Regular 11pt minimum, Deep Brown on Cream. Icons used only from approved symbol set. No third-party icon packs."),
    ], seed=32)


def clothing_page(c):
    placeholder_section(c, 34, "Clothing", "Staff uniform and branded apparel guidelines.",
    [
        ("Apron",        "Waxed canvas or linen in Deep Brown (#5F4738). Cup icon mark embroidered in Cream thread, chest left. No wordmark on apron. One size range, adjustable straps."),
        ("T-Shirt",      "Cream base, Deep Brown logo mark centred front. Helvetica 8pt address on back lower hem. Fabric: 100% organic cotton minimum 180gsm."),
        ("Cap",          "Structured 5-panel in Warm Brown. Cup icon mark embroidered in Cream on front panel. No text on cap."),
        ("Tote Bag",     "Natural cotton canvas. Cup icon + wordmark screen-printed in Deep Brown. Handles in Deep Brown webbing. Used as customer gift and retail item."),
    ], seed=34)


def banners_page(c):
    placeholder_section(c, 35, "Banners", "Event, exterior, and digital banner specifications.",
    [
        ("Feather Banner", "2500mm × 700mm. Cream fabric, Deep Brown logo mark + wordmark. No tagline on feather banners. Minimum clear zone 60mm."),
        ("Pop-Up Table",   "Table throw in Deep Brown. Cream wordmark centred. Gold border rule 10mm from all edges. Machine-washable fabric required."),
        ("Digital Banner", "728×90px leaderboard: Cream background, logo left-aligned, tagline centred, CTA right. 300×250px rectangle: logo centred, single CTA below."),
        ("Event Backwall", "3000mm × 2400mm. Full brand pattern: watercolour blobs at 20% opacity on Cream. Logo centred at 300mm wide. Tagline 40pt Times Italic below."),
    ], seed=35)


def branch_elements_page(c):
    placeholder_section(c, 36, "Branch Elements", "Consistent design language across all physical touchpoints.",
    [
        ("Flooring",     "Natural hardwood or large-format cement tile in warm neutral tones. No patterned flooring in service areas."),
        ("Walls",        "Cream plaster or limewash finish as primary surface. One feature wall per space in Deep Brown. Exposed brick retained where original."),
        ("Fixtures",     "Matte black hardware throughout. Warm brass accents for hooks, handles, and display fittings. No chrome."),
        ("Lighting",     "Pendant lights over bar in matte black or aged brass. Colour temperature 2700K throughout. No fluorescent lighting."),
    ], seed=36)


def space_page(c, pg_num, title, subtitle, notes, seed=0):
    placeholder_section(c, pg_num, title, subtitle, notes, seed=seed)


# ── Main Builder ───────────────────────────────────────────────────────────────

def build():
    output_path = "/Users/gaian/Projects/startups/Qumak/qumak-backend/morning_ritual_brand_guidelines.pdf"
    c = canvas.Canvas(output_path, pagesize=A4)
    c.setTitle("Morning Ritual — Brand Guidelines 2025")
    c.setAuthor("Morning Ritual")
    c.setSubject("Official Brand Guidelines Document")

    # Page builder list: (function, args)
    pages = [
        (cover_page,         [c]),
        (toc_page,           [c]),
        # Pages 3-6 are blank / placeholder (intro spread)
        (brand_identity_page,[c]),      # 7
        (values_page,        [c]),      # 8
        (logo_page,          [c]),      # 9
        (logo_guidelines_page,[c]),     # 10
        (tagline_page,       [c]),      # 11
        (logo_usage_page,    [c]),      # 12
        (imagery_page,       [c]),      # 13
        # 14-18 additional imagery pages
        (lambda c: placeholder_section(c, 14, "Imagery", "Photography selection — beverages.",
            [("Hero Shot", "Full-bleed overhead of espresso in ceramic cup on wooden surface. Steam visible. Natural side-light from left."),
             ("Process", "Barista tamping, pouring, or presenting. Detail focus. Warm shallow depth of field."),
             ("Still Life", "Bean close-ups, grinder detail, portafilter. Macro lens. Cream-dominant composition.")], seed=14), [c]),
        (lambda c: placeholder_section(c, 15, "Imagery", "Photography selection — space.",
            [("Exterior", "Morning light on storefront. Signage legible. One person entering or departing, blurred."),
             ("Interior Wide", "Full-room editorial. Show bar, seating, light. No customers clearly identifiable."),
             ("Interior Detail", "Surface textures, plant details, ceramic vessels, books. No people required.")], seed=15), [c]),
        (lambda c: placeholder_section(c, 16, "Imagery", "Photography — seasonal and campaign.",
            [("Seasonal", "Ingredient-led: spices, citrus, botanicals beside a beverage. Colour-coded to seasonal palette."),
             ("Campaign", "Consistent set with unified art direction per campaign. Minimum 8 images per set."),
             ("Social", "Square 1:1 format. Bold composition, single subject. Warm filter, 10–15% film grain.")], seed=16), [c]),
        (lambda c: placeholder_section(c, 17, "Imagery", "Video and motion standards.",
            [("Format", "16:9 primary, 9:16 for Instagram / TikTok. 4K capture, 1080p delivery minimum."),
             ("Pacing", "Slow, deliberate cuts. 3–5 seconds minimum per shot. No jump cuts or fast edits."),
             ("Audio", "Ambient café sounds or minimal acoustic music. No voice-over in brand content.")], seed=17), [c]),
        (lambda c: placeholder_section(c, 18, "Imagery", "Illustration and graphic elements.",
            [("Style", "Hand-drawn, slightly imperfect linework in Deep Brown or Terracotta on Cream background."),
             ("Use Cases", "Seasonal packaging, limited edition cups, event posters. Never substitute for photography in hero contexts."),
             ("Restrictions", "No digital illustration or 3D render. No stock illustration. Commission only.")], seed=18), [c]),
        # 19
        (lambda c: placeholder_section(c, 19, "Sponsorship", "Partnership and co-branding standards.",
            [("Eligibility", "Morning Ritual sponsors local cultural events, independent publishers, and artisan markets aligned with our values. No fast food, tobacco, or alcohol co-branding."),
             ("Logo Placement", "Partner logos placed below the Morning Ritual logo, separated by a 0.5pt rule. Equal sizing unless contractually specified. Partner logos must meet our minimum size requirements."),
             ("Exclusivity", "Category exclusivity available for flagship sponsors. All co-branded materials must be approved by Morning Ritual creative team prior to production.")], seed=19), [c]),
        (colours_page,       [c]),      # 20
        (typography_page,    [c]),      # 21
        (writing_guide_page, [c]),      # 22
        (email_closing_page, [c]),      # 23
        (stationery_page,    [c]),      # 24
        (applications_page,  [c]),      # 25
        (image_usage_page,   [c]),      # 26
        # 27-30 extended image usage
        (lambda c: placeholder_section(c, 27, "Image Usage", "Social media platform specifications.",
            [("Instagram", "1:1 at 1080×1080px for feed. 9:16 at 1080×1920px for Stories. 4:5 recommended for grid optimisation."),
             ("Facebook", "1200×630px for link previews. 820×312px for cover photos. 170×170px profile (logo mark only)."),
             ("Google Business", "720×720px minimum. At least 3 exterior, 3 interior, 1 team photo required.")], seed=27), [c]),
        (lambda c: placeholder_section(c, 28, "Image Usage", "Print publication specifications.",
            [("Press Kit", "300 DPI TIFF. CMYK colour profile. Include both horizontal and vertical crops. Provide caption sheet."),
             ("Magazine", "Full-page: 210×297mm + 5mm bleed. Half-page: 190×124mm. Supply as layered PDF with embedded fonts."),
             ("Newspaper", "Minimum 150 DPI. Provide greyscale version. Deep Brown renders as 80% black in B&W print.")], seed=28), [c]),
        (lambda c: placeholder_section(c, 29, "Image Usage", "Digital advertising specifications.",
            [("Display Ads", "Leaderboard 728×90, Rectangle 300×250, Half-page 300×600, Billboard 970×250."),
             ("Social Ads", "Facebook/Instagram: 1080×1080 or 1080×1350. LinkedIn: 1200×627. Twitter/X: 1200×675."),
             ("File Formats", "Static: PNG or JPG. Animated: MP4 max 15 seconds, no auto-play audio. GIF only for social.")], seed=29), [c]),
        (lambda c: placeholder_section(c, 30, "Image Usage", "Internal and operational use.",
            [("Presentations", "Use Morning Ritual PowerPoint template. Never use personal slide themes for external presentations."),
             ("Internal Comms", "Slack and email may use informal imagery. Slack profile pictures: headshot or Morning Ritual avatar."),
             ("Printed Materials", "All internally printed materials (menus, training docs) must use approved templates from the brand drive.")], seed=30), [c]),
        (symbols_page,       [c]),      # 31
        (signage_page,       [c]),      # 32
        # 33 extended signage
        (lambda c: placeholder_section(c, 33, "Signage", "Digital and interactive signage.",
            [("Menu Screens", "Samsung or LG commercial display, 55\" minimum. 4K resolution. Content managed via approved CMS."),
             ("QR Codes", "Rounded-corner modules. Minimum 25×25mm print size. Always test scan before production."),
             ("A-Frame", "Chalkboard A-frame 600×900mm. Daily special only. Handwritten in white chalk, category in gold marker.")], seed=33), [c]),
        (clothing_page,      [c]),      # 34
        (banners_page,       [c]),      # 35
        (branch_elements_page,[c]),     # 36
        # 37-48 space pages
        (lambda c: space_page(c, 37, "Entrance", "First impressions and arrival experience.",
            [("Doorway", "Double door preferred. Matte black handle hardware. Door pull engraved with cup icon mark."),
             ("Welcome Mat", "Natural coir in Deep Brown. 'Morning Ritual' in Cream letterpress. 600×900mm."),
             ("Scent", "No artificial fragrances. The natural aroma of fresh coffee and toasted bread is the brand scent.")], seed=37), [c]),
        (lambda c: space_page(c, 38, "Showroom", "Display area and retail presentation.",
            [("Shelving", "Raw oak floating shelves with matte black brackets. 300mm depth. Product displayed face-forward."),
             ("Retail Arrangement", "Beans front-left, accessories mid, branded merchandise right. Price tags in Cream card with Deep Brown stamp."),
             ("Lighting", "Adjustable track lighting at 45° angle to product. 2700K LED. 500–800 lux at shelf level.")], seed=38), [c]),
        (lambda c: space_page(c, 39, "Showroom Image Usage", "Photography within the retail display.",
            [("Product Shots", "Shot on Cream or Light Beige seamless paper. Single item per hero frame. Shadow optional, not hard."),
             ("Context Shots", "Product in situ on shelf or counter. Other products soft-blurred in background."),
             ("Scale Reference", "Include hand, cup, or familiar object in at least one image per product to establish scale.")], seed=39), [c]),
        (lambda c: space_page(c, 40, "Showroom Image Usage", "Seasonal merchandising and display rotation.",
            [("Frequency", "Display refreshed quarterly. Major seasonal change (Spring/Autumn), minor refresh (Summer/Winter)."),
             ("Seasonal Colours", "Spring: Sage and Cream. Summer: Terracotta and Beige. Autumn: Deep Brown and Gold. Winter: Dark Roast and Cream."),
             ("Props", "Seasonal botanicals, linen cloths, ceramic vessels. No plastic. No artificial flowers.")], seed=40), [c]),
        (lambda c: space_page(c, 41, "Delivery Area", "Receiving dock and supplier access standards.",
            [("Signage", "Helvetica Bold 'Deliveries' in Cream on Deep Brown panel. Arrow directional signage."),
             ("Schedule Board", "Whiteboard with daily delivery schedule. Updated each morning. Permanent marker, not chalk."),
             ("Presentation", "Delivery area must be clear of refuse before opening. All cardboard broken flat and stored. Public-facing delivery door in Deep Brown paint.")], seed=41), [c]),
        (lambda c: space_page(c, 42, "Workshop", "Staff preparation and training space.",
            [("Barista Station", "Cupping table in raw oak. EK43 grinder. Chemex, AeroPress, V60 on open shelving. No clutter."),
             ("Training Materials", "Bound training manual in Morning Ritual binding. Laminated quick-reference cards behind bar."),
             ("Inspiration Wall", "A3 prints of sourcing partners, harvest photos, and brewing guides. Updated bi-annually.")], seed=42), [c]),
        (lambda c: space_page(c, 43, "Brand-Independent Workshop", "Neutral space for external events and collaborations.",
            [("Neutralisation", "Remove branded items from view. Use unbranded cups. Cover logo on espresso machine with neutral panel if required."),
             ("Agreements", "Third-party events must sign a space usage agreement confirming no competing coffee brands are served on premises."),
             ("Return Protocol", "Full branding restored within 2 hours of event close. Checklist completed and signed by duty manager.")], seed=43), [c]),
        (lambda c: space_page(c, 44, "Waiting Area", "Customer comfort and in-queue experience.",
            [("Seating", "2–3 stools at counter window. Natural wood, no cushions required. Below-bar storage for personal items."),
             ("Queue Management", "Single-file queue along the left wall. Floor guide in Deep Brown vinyl strip. Staff to acknowledge all queuing customers within 30 seconds."),
             ("In-Queue Content", "Printed story card about the current seasonal origin, available to take. Optional: QR link to barista origin video.")], seed=44), [c]),
        (lambda c: space_page(c, 45, "Office Space", "Back-of-house and administrative environment.",
            [("Equipment", "Mac hardware preferred. Deep Brown or Space Grey only. No consumer-grade printer visible to staff in primary workspace."),
             ("Branding", "Minimal. One framed brand values print (A3, white frame). Morning Ritual stationery at all desks."),
             ("Tidiness", "Zero-paper policy where possible. Open shelving with uniform binders in Cream/Deep Brown. No personal clutter visible in any staff-facing camera feed.")], seed=45), [c]),
        (lambda c: space_page(c, 46, "Restroom", "Hygiene and brand coherence in guest facilities.",
            [("Signage", "Helvetica Regular, Deep Brown on Cream. Pictogram from approved symbol set only."),
             ("Fixtures", "Matte black tap hardware. White ceramic basin. Warm-tone hand towels in linen colour. Refillable dispensers only — no branded hotel-style bottles."),
             ("Scent", "Light citrus or unscented hand soap. No aerosol room spray. Fresh flowers quarterly or dried botanicals.")], seed=46), [c]),
        (lambda c: space_page(c, 47, "Lighting Strip", "Accent and architectural lighting guidelines.",
            [("Specification", "LED strip 2700K CRI90+. Used under bar counter and floating shelves only. Not used as primary space lighting."),
             ("Control", "Dimmable to 30% minimum. Morning (opening–10am): 60%. Day: 40%. Evening: 80% for atmosphere."),
             ("Maintenance", "Replaced every 12 months regardless of failure. Colour temperature consistency checked monthly with light meter.")], seed=47), [c]),
        (lambda c: space_page(c, 48, "Outdoor Area", "Pavement seating and exterior guest experience.",
            [("Furniture", "Black powder-coated steel bistro tables and chairs. 2-top tables only outdoors. No branded tablecloths outdoors."),
             ("Barriers", "Sage linen rope barriers on black posts. Minimum clear pavement 1500mm per DOT requirements."),
             ("Signage", "A4 laminated table cards: Wi-Fi password and QR to menu. Deep Brown card stock. Replaced monthly.")], seed=48), [c]),
    ]

    for fn, args in pages:
        fn(*args)
        c.showPage()

    c.save()
    print(f"✓  Saved: {output_path}")
    return output_path


if __name__ == "__main__":
    build()
