/**
 * pdfService.js — Comprehensive Brand Guidelines PDF generator
 * Generates 30+ page brand book covering identity, logo usage,
 * typography, colours, stationery, signage, clothing, and space design.
 * Uses Claude AI to generate section-specific guidelines text.
 */
const PDFDocument = require('pdfkit');

const C = {
  black: '#0f0f0f',
  dark: '#1a1a2e',
  brand: '#944a00',
  brandL: '#fc8f34',
  white: '#ffffff',
  cream: '#fff9f5',
  gray: '#f7fafc',
  grayMed: '#e5e7eb',
  text: '#374151',
  textLight: '#6b7280',
  sectionBg: '#f1f4f6',
};

function drawPageHeader(doc, title, subtitle, bgColor = C.brand) {
  doc.rect(0, 0, doc.page.width, 90).fill(bgColor);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(24).text(title, 50, 28);
  if (subtitle) doc.fillColor('rgba(255,255,255,0.6)').font('Helvetica').fontSize(11).text(subtitle, 50, 58);
}

function drawPageNumber(doc, num) {
  doc.fillColor(C.textLight).font('Helvetica').fontSize(9)
    .text(String(num), doc.page.width - 70, doc.page.height - 40, { width: 40, align: 'right' });
}

function drawSectionDivider(doc, y, label) {
  doc.rect(50, y, 495, 1).fill(C.grayMed);
  if (label) doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), 50, y + 6, { characterSpacing: 1.5 });
  return y + (label ? 24 : 8);
}

function wrapText(doc, text, x, y, opts = {}) {
  const defaults = { width: 495, lineGap: 4 };
  doc.fillColor(opts.color || C.text).font(opts.font || 'Helvetica').fontSize(opts.size || 11)
    .text(text || '', x, y, { ...defaults, ...opts });
  return doc.y;
}

function drawColorSwatch(doc, hex, x, y, w = 100, h = 50) {
  try { doc.rect(x, y, w, h).fill(hex); } catch { doc.rect(x, y, w, h).fill('#cccccc'); }
  doc.fillColor(C.text).font('Helvetica').fontSize(9).text((hex || '').toUpperCase(), x, y + h + 4);
  return y + h + 20;
}

function addPageIfNeeded(doc, yPos, minSpace = 120) {
  if (yPos > doc.page.height - minSpace) { doc.addPage(); return 50; }
  return yPos;
}

async function generateAIGuidelines(brand) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Generate brand guidelines JSON for "${brand.brandName || 'Brand'}".
Brand story: ${brand.brandStory || 'N/A'}
Tagline: ${brand.tagline || 'N/A'}
Category: ${brand.category || 'luxury'}
Voice: ${(brand.brandVoice || []).join(', ') || 'premium'}
Colors: primary=${brand.colorPalette?.primary || '#000'}, secondary=${brand.colorPalette?.secondary || '#444'}, accent=${brand.colorPalette?.accent || '#fc8f34'}

Return ONLY valid JSON (no markdown) with these keys:
{
  "values": ["value1","value2","value3","value4","value5"],
  "valuesDescription": "2-sentence brand values summary",
  "logoGuidelines": "3-4 sentences on logo clear space, minimum size, placement rules",
  "logoUsageDont": ["dont1","dont2","dont3","dont4"],
  "taglineUsage": "2-3 sentences on how to use the tagline",
  "imageStyle": "2-3 sentences on photography/image style",
  "sponsorshipGuidelines": "2-3 sentences on sponsorship branding",
  "typographyPrimary": "Font name for headings",
  "typographySecondary": "Font name for body",
  "typographyRules": "3-4 sentences on typography hierarchy",
  "writingGuide": "4-5 sentences on brand voice and writing style",
  "emailClosing": "Standard email signature format (2-3 lines)",
  "stationeryNotes": "2-3 sentences on letterhead, business card, envelope design",
  "symbolsDescription": "2 sentences on brand symbols and icons usage",
  "signageGuidelines": "3 sentences on exterior and interior signage",
  "clothingGuidelines": "2-3 sentences on branded apparel and uniforms",
  "bannerGuidelines": "2-3 sentences on event banners and roll-ups",
  "entranceDesign": "2 sentences on store/office entrance branding",
  "showroomDesign": "2-3 sentences on showroom layout and branding",
  "deliveryBranding": "2 sentences on delivery packaging and vehicles",
  "officeDesign": "2 sentences on office space branding",
  "outdoorGuidelines": "2 sentences on outdoor area branding"
}`
      }],
    });
    const raw = resp.content?.[0]?.text || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('[AI Guidelines]', e.message);
    return {};
  }
}

async function generateBrandKitPDF(brand, inputs, options = {}) {
  const { logoBase64 } = options;
  const ai = await generateAIGuidelines(brand);
  const palette = brand.colorPalette || {};
  const primary = palette.primary || C.brand;
  const secondary = palette.secondary || C.dark;
  const accent = palette.accent || C.brandL;
  const bg = palette.background || C.cream;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let pg = 1;

    // ═══════════════════════════════════════════════════════════
    // PAGE 1 — COVER
    // ═══════════════════════════════════════════════════════════
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.black);

    // Gradient-like accent strip
    doc.rect(0, doc.page.height * 0.62, doc.page.width, 6).fill(primary);
    doc.rect(0, doc.page.height * 0.63, doc.page.width, 2).fill(accent);

    // Logo image on cover if available
    if (logoBase64) {
      try {
        const logoBuffer = Buffer.from(logoBase64, 'base64');
        doc.image(logoBuffer, 50, 120, { width: 100, height: 100 });
      } catch (e) { /* logo rendering failed, skip */ }
    }

    const nameY = logoBase64 ? 250 : 200;
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(56)
      .text(brand.brandName || 'Brand Kit', 50, nameY, { width: 495 });
    doc.fillColor(C.white).font('Helvetica').fontSize(18)
      .text(brand.tagline || '', 50, nameY + 70, { width: 495 });
    doc.fillColor('rgba(255,255,255,0.2)').fontSize(12)
      .text('Brand Guidelines', 50, doc.page.height - 120);
    doc.fillColor('rgba(255,255,255,0.3)').fontSize(10)
      .text(`Generated by Qumak · ${new Date().toLocaleDateString('en-AE', { year: 'numeric', month: 'long', day: 'numeric' })}`, 50, doc.page.height - 100);
    pg++;

    // ═══════════════════════════════════════════════════════════
    // PAGE 2 — TABLE OF CONTENTS
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Contents', 'Brand Guidelines', C.black);
    const tocItems = [
      'Brand Identity Elements', 'Values', 'Logo', 'Logo Guidelines',
      'Tagline', 'Logo Usage', 'Image Style', 'Colours', 'Typography',
      'Writing Guide', 'Email Closing', 'Stationery',
      'Application of Services', 'Image Usage', 'Symbols', 'Signage',
      'Clothing', 'Banners', 'Showroom', 'Office & Spaces',
      'Product Specification', 'Financial Overview', 'Marketing Kit',
    ];
    let ty = 110;
    tocItems.forEach((item, i) => {
      doc.fillColor(C.text).font('Helvetica').fontSize(11).text(`${i + 3}.`, 50, ty, { width: 30 });
      doc.fillColor(C.text).font('Helvetica').fontSize(11).text(item, 80, ty);
      const dots = '.'.repeat(60);
      doc.fillColor(C.grayMed).font('Helvetica').fontSize(9).text(dots, 280, ty + 2, { width: 200, align: 'right' });
      doc.fillColor(C.textLight).font('Helvetica').fontSize(10).text(String(i + 3), 500, ty, { width: 45, align: 'right' });
      ty += 24;
      if (ty > 740) { doc.addPage(); ty = 50; }
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 3 — BRAND IDENTITY ELEMENTS
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Brand Identity Elements', 'Core visual and verbal identity', primary);
    let y = 110;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(14).text('Brand Story', 50, y);
    y = wrapText(doc, brand.brandStory || '', 50, y + 20) + 20;
    y = drawSectionDivider(doc, y, 'Positioning');
    y = wrapText(doc, brand.positioning || '', 50, y) + 20;
    y = drawSectionDivider(doc, y, 'Brand Voice');
    (brand.brandVoice || []).forEach(v => {
      doc.rect(50, y, 8, 8).fill(primary);
      doc.fillColor(C.text).font('Helvetica').fontSize(11).text(v, 66, y - 1);
      y += 22;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 4 — VALUES
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Values', 'What we stand for', C.black);
    y = 110;
    wrapText(doc, ai.valuesDescription || `${brand.brandName} is built on core values that guide every decision.`, 50, y, { size: 13 });
    y = doc.y + 24;
    (ai.values || ['Excellence', 'Innovation', 'Authenticity', 'Craftsmanship', 'Integrity']).forEach((v, i) => {
      doc.rect(50, y, 495, 44).fill(i % 2 === 0 ? C.gray : C.white);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(20).text(String(i + 1), 64, y + 12);
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(13).text(v, 100, y + 14);
      y += 48;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 5 — LOGO
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Logo', 'Primary brand mark', primary);
    y = 110;
    doc.rect(50, y, 495, 180).fill(C.gray);
    if (logoBase64) {
      try {
        const logoBuf = Buffer.from(logoBase64, 'base64');
        doc.image(logoBuf, (doc.page.width - 140) / 2, y + 20, { width: 140, height: 140 });
      } catch (_) {
        doc.fillColor(primary).font('Helvetica-Bold').fontSize(36)
          .text(brand.brandName || 'LOGO', 0, y + 65, { width: doc.page.width, align: 'center' });
      }
    } else {
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(36)
        .text(brand.brandName || 'LOGO', 0, y + 65, { width: doc.page.width, align: 'center' });
    }
    doc.fillColor(C.textLight).font('Helvetica').fontSize(10)
      .text('Primary Logo — Full Color', 0, y + 190, { width: doc.page.width, align: 'center' });
    y += 220;

    doc.rect(50, y, 240, 120).fill(C.black);
    if (logoBase64) {
      try {
        const logoBuf2 = Buffer.from(logoBase64, 'base64');
        doc.image(logoBuf2, 120, y + 10, { width: 100, height: 100 });
      } catch (_) {
        doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22)
          .text(brand.brandName || '', 60, y + 45, { width: 220, align: 'center' });
      }
    } else {
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(22)
        .text(brand.brandName || '', 60, y + 45, { width: 220, align: 'center' });
    }
    doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text('Reversed / Dark background', 60, y + 126);

    doc.rect(305, y, 240, 120).fill(C.white).stroke(C.grayMed);
    if (logoBase64) {
      try {
        const logoBuf3 = Buffer.from(logoBase64, 'base64');
        doc.image(logoBuf3, 375, y + 10, { width: 100, height: 100 });
      } catch (_) {
        doc.fillColor(primary).font('Helvetica-Bold').fontSize(22)
          .text(brand.brandName || '', 315, y + 45, { width: 220, align: 'center' });
      }
    } else {
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(22)
        .text(brand.brandName || '', 315, y + 45, { width: 220, align: 'center' });
    }
    doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text('Light background', 315, y + 126);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 6 — LOGO GUIDELINES
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Logo Guidelines', 'Clear space and minimum size', C.black);
    y = 110;
    wrapText(doc, ai.logoGuidelines || 'Maintain clear space equal to the height of the logo mark on all sides. Minimum size: 24mm for print, 80px for digital. Always use supplied files — never recreate.', 50, y, { size: 12 });
    y = doc.y + 24;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(12).text('Clear Space', 50, y);
    y += 18;
    doc.rect(140, y, 310, 120).fill(C.gray);
    doc.rect(170, y + 20, 250, 80).strokeColor(primary).lineWidth(1).dash(4).stroke().undash();
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(18).text(brand.brandName || '', 0, y + 45, { width: 595, align: 'center' });
    doc.fillColor(C.brand).font('Helvetica').fontSize(8).text('X', 155, y + 55);
    doc.fillColor(C.brand).font('Helvetica').fontSize(8).text('X', 430, y + 55);
    y += 150;
    y = drawSectionDivider(doc, y, 'Incorrect Usage');
    const donts = ai.logoUsageDont || ['Do not stretch or distort', 'Do not change colors', 'Do not add effects', 'Do not rotate'];
    donts.forEach((d, i) => {
      doc.rect(50 + (i % 2) * 250, y + Math.floor(i / 2) * 36, 8, 8).fill('#dc2626');
      doc.fillColor(C.text).font('Helvetica').fontSize(11).text(d, 66 + (i % 2) * 250, y + Math.floor(i / 2) * 36 - 1, { width: 230 });
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 7 — TAGLINE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Tagline', 'Brand message', primary);
    y = 120;
    doc.rect(50, y, 495, 100).fill(C.gray);
    doc.fillColor(C.black).font('Helvetica-BoldOblique').fontSize(22)
      .text(`"${brand.tagline || ''}"`, 70, y + 35, { width: 455, align: 'center' });
    y += 120;
    wrapText(doc, ai.taglineUsage || 'The tagline should be used alongside the logo or as a standalone element. Always render in the primary brand font. Maintain consistent sizing.', 50, y);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 8 — LOGO USAGE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Logo Usage', 'Approved applications', C.black);
    y = 110;
    const usages = ['Business Cards', 'Letterhead', 'Social Media', 'Signage', 'Packaging', 'Website'];
    usages.forEach((u, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 50 + col * 170;
      const boxY = y + row * 100;
      doc.rect(x, boxY, 155, 80).fill(C.gray);
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(11).text(u, x + 10, boxY + 30, { width: 135, align: 'center' });
      doc.fillColor(primary).font('Helvetica').fontSize(8).text('APPROVED', x + 10, boxY + 60, { width: 135, align: 'center' });
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 9 — IMAGE STYLE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Image Style', 'Photography and visual direction', primary);
    y = 110;
    wrapText(doc, ai.imageStyle || 'Use natural, warm-toned photography with shallow depth of field. Preferred compositions: center-weighted for product, rule-of-thirds for lifestyle. Avoid heavy filters.', 50, y, { size: 12 });
    y = doc.y + 24;
    doc.rect(50, y, 240, 140).fill(C.gray);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(10).text('Product Photography', 50, y + 150);
    doc.rect(305, y, 240, 140).fill(C.sectionBg);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(10).text('Lifestyle / Ambiance', 305, y + 150);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 10 — SPONSORSHIP
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Sponsorship', 'Co-branding and partnerships', C.black);
    y = 110;
    wrapText(doc, ai.sponsorshipGuidelines || 'When co-branding with sponsors, maintain logo clear space rules. The brand logo should always appear with equal or greater prominence than partner logos.', 50, y, { size: 12 });
    y = doc.y + 24;
    doc.rect(50, y, 495, 120).fill(C.gray);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(20).text(brand.brandName || '', 80, y + 45);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(14).text('x  Partner', 320, y + 48);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 11 — COLOURS
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Colours', 'Brand colour palette', primary);
    y = 110;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(12).text('Primary Palette', 50, y);
    y += 22;
    const allColors = [
      { label: 'Primary', hex: primary },
      { label: 'Secondary', hex: secondary },
      { label: 'Accent', hex: accent },
      { label: 'Background', hex: bg },
    ];
    allColors.forEach((c, i) => {
      const x = 50 + i * 125;
      try { doc.rect(x, y, 110, 70).fill(c.hex); } catch { doc.rect(x, y, 110, 70).fill('#ccc'); }
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(10).text(c.label, x, y + 76);
      doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text((c.hex || '').toUpperCase(), x, y + 90);
    });
    y += 120;
    y = drawSectionDivider(doc, y, 'Usage Rules');
    wrapText(doc, `Primary color (${primary}) is used for logos, headings, and primary CTAs. Secondary (${secondary}) for backgrounds and supporting elements. Accent (${accent}) for highlights, links, and interactive states. Background (${bg}) for page canvas and cards.`, 50, y);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 12 — TYPOGRAPHY
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Typography', 'Type hierarchy and usage', C.black);
    y = 110;
    const headingFont = ai.typographyPrimary || 'Public Sans';
    const bodyFont = ai.typographySecondary || 'Poppins';
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(12).text('Primary — Headings', 50, y);
    y += 18;
    doc.rect(50, y, 495, 80).fill(C.gray);
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(32).text(headingFont, 70, y + 10);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(11).text('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 70, y + 50);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(11).text('abcdefghijklmnopqrstuvwxyz 0123456789', 70, y + 64);
    y += 100;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(12).text('Secondary — Body', 50, y);
    y += 18;
    doc.rect(50, y, 495, 80).fill(C.sectionBg);
    doc.fillColor(C.black).font('Helvetica').fontSize(28).text(bodyFont, 70, y + 10);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(11).text('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 70, y + 48);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(11).text('abcdefghijklmnopqrstuvwxyz 0123456789', 70, y + 62);
    y += 100;
    y = drawSectionDivider(doc, y, 'Type Scale');
    const typeScale = [
      { name: 'H1 — Display', size: '48px / 3rem', weight: 'Bold' },
      { name: 'H2 — Section', size: '32px / 2rem', weight: 'Bold' },
      { name: 'H3 — Subsection', size: '24px / 1.5rem', weight: 'Semi-Bold' },
      { name: 'Body', size: '16px / 1rem', weight: 'Regular' },
      { name: 'Caption', size: '12px / 0.75rem', weight: 'Regular' },
    ];
    typeScale.forEach(t => {
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(10).text(t.name, 50, y);
      doc.fillColor(C.textLight).font('Helvetica').fontSize(10).text(`${t.size} · ${t.weight}`, 250, y);
      y += 20;
    });
    wrapText(doc, ai.typographyRules || '', 50, y + 8, { size: 10, color: C.textLight });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 13 — WRITING GUIDE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Writing Guide', 'Tone, voice, and editorial style', primary);
    y = 110;
    wrapText(doc, ai.writingGuide || `${brand.brandName} communicates with confidence and clarity. The tone is premium but approachable — never condescending. Use active voice, short sentences, and evocative language. Address the reader directly with "you" and "your".`, 50, y, { size: 12, lineGap: 6 });
    y = doc.y + 20;
    y = drawSectionDivider(doc, y, 'Do / Don\'t');
    const voiceExamples = [
      { do: 'Speak with confidence', dont: 'Sound arrogant or dismissive' },
      { do: 'Be concise and clear', dont: 'Use jargon or filler words' },
      { do: 'Inspire and elevate', dont: 'Over-promise or exaggerate' },
    ];
    voiceExamples.forEach(v => {
      doc.rect(50, y, 240, 30).fill('#ecfdf5');
      doc.fillColor('#059669').font('Helvetica-Bold').fontSize(10).text(`DO: ${v.do}`, 60, y + 9);
      doc.rect(305, y, 240, 30).fill('#fef2f2');
      doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(10).text(`DON'T: ${v.dont}`, 315, y + 9);
      y += 38;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 14 — EMAIL CLOSING
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Email Closing', 'Standard email signatures', C.black);
    y = 110;
    doc.rect(50, y, 495, 160).fill(C.gray);
    const emailSig = ai.emailClosing || `Warm regards,\n[Name] | ${brand.brandName}\n[title] | [phone]\n${brand.brandName?.toLowerCase()}.ae`;
    doc.fillColor(C.black).font('Helvetica').fontSize(11).text(emailSig, 70, y + 20, { width: 455, lineGap: 6 });
    y += 180;
    wrapText(doc, 'All email correspondence should use the brand email signature. Include name, title, phone number, and website. Use the brand primary color for the name line.', 50, y, { size: 11, color: C.textLight });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 15 — STATIONERY
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Stationery', 'Letterhead, business cards, envelopes', primary);
    y = 110;
    wrapText(doc, ai.stationeryNotes || 'All printed stationery uses premium 300gsm cardstock. The logo appears in the top-left corner with a minimum margin of 15mm. Business cards use a vertical layout with the brand color strip on the left edge.', 50, y, { size: 12 });
    y = doc.y + 20;
    doc.rect(50, y, 155, 200).fill(C.gray).stroke(C.grayMed);
    doc.rect(50, y, 155, 6).fill(primary);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(8).text(brand.brandName || '', 60, y + 16);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(7).text('Letterhead A4', 50, y + 206);
    doc.rect(225, y, 130, 80).fill(C.white).stroke(C.grayMed);
    doc.rect(225, y, 4, 80).fill(primary);
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(7).text(brand.brandName || '', 236, y + 10);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(6).text('[Name]\n[Title]\n[Phone]\n[Email]', 236, y + 24);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(7).text('Business Card', 225, y + 86);
    doc.rect(375, y, 170, 90).fill(C.white).stroke(C.grayMed);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(8).text(brand.brandName || '', 385, y + 12);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(7).text('Envelope DL', 375, y + 96);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 16 — APPLICATION OF SERVICES
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Application of Services', 'Branded touchpoints and formulas', C.black);
    y = 110;
    wrapText(doc, 'Every customer touchpoint should reflect the brand identity. From the first impression to after-sales service, consistency builds trust and recognition.', 50, y, { size: 12 });
    y = doc.y + 20;
    const services = ['Website / App', 'Social Media', 'Customer Service', 'Packaging', 'In-Store', 'After-Sales'];
    services.forEach((s, i) => {
      doc.rect(50, y, 495, 36).fill(i % 2 === 0 ? C.gray : C.white);
      doc.rect(50, y, 4, 36).fill(primary);
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(11).text(s, 66, y + 11);
      doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text('Apply full brand guidelines', 300, y + 13, { width: 240, align: 'right' });
      y += 40;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 17 — IMAGE USAGE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Image Usage', 'Photography guidelines and restrictions', primary);
    y = 110;
    const imgRules = [
      { title: 'Approved', desc: 'High-resolution, warm tones, natural lighting, brand-relevant subjects', color: '#059669' },
      { title: 'Restricted', desc: 'Stock photos with watermarks, low resolution, unrelated subjects', color: '#dc2626' },
      { title: 'Color Treatment', desc: `Apply warm filter consistent with brand palette (${primary})`, color: C.brand },
    ];
    imgRules.forEach(r => {
      doc.rect(50, y, 495, 50).fill(C.gray);
      doc.rect(50, y, 4, 50).fill(r.color);
      doc.fillColor(r.color).font('Helvetica-Bold').fontSize(11).text(r.title, 66, y + 10);
      doc.fillColor(C.text).font('Helvetica').fontSize(10).text(r.desc, 66, y + 28, { width: 470 });
      y += 58;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 18 — SYMBOLS
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Symbols & Icons', 'Iconography system', C.black);
    y = 110;
    wrapText(doc, ai.symbolsDescription || 'Use line-weight icons (1.5px stroke) in the brand primary color. Icons should be simple, geometric, and consistent in style across all applications.', 50, y, { size: 12 });
    y = doc.y + 24;
    for (let i = 0; i < 8; i++) {
      const x = 50 + (i % 4) * 125;
      const boxY = y + Math.floor(i / 4) * 80;
      doc.rect(x, boxY, 110, 60).fill(C.gray);
      doc.fillColor(primary).font('Helvetica').fontSize(24).text('◆', x + 42, boxY + 14);
    }
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 19 — SIGNAGE
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Signage', 'Exterior and interior signs', primary);
    y = 110;
    wrapText(doc, ai.signageGuidelines || 'Exterior signage uses backlit channel letters in the primary color. Interior wayfinding uses the secondary font at 24pt minimum. All signage must be approved by brand management.', 50, y, { size: 12 });
    y = doc.y + 24;
    doc.rect(50, y, 495, 140).fill(C.black);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(28).text(brand.brandName || '', 0, y + 50, { width: 595, align: 'center' });
    doc.fillColor('rgba(255,255,255,0.3)').font('Helvetica').fontSize(9).text('Exterior Signage — Backlit', 0, y + 148, { width: 595, align: 'center' });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 20 — CLOTHING
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Clothing', 'Branded apparel and uniforms', C.black);
    y = 110;
    wrapText(doc, ai.clothingGuidelines || 'Uniforms feature the brand logo embroidered on the left chest area. Colors should match the primary palette. Staff T-shirts use the dark variant with white logo.', 50, y, { size: 12 });
    y = doc.y + 24;
    const clothItems = ['Polo Shirt', 'T-Shirt', 'Apron', 'Cap'];
    clothItems.forEach((c, i) => {
      const x = 50 + (i % 2) * 250;
      const boxY = y + Math.floor(i / 2) * 100;
      doc.rect(x, boxY, 235, 80).fill(i === 1 || i === 3 ? C.black : C.gray);
      doc.fillColor(i === 1 || i === 3 ? C.white : primary).font('Helvetica-Bold').fontSize(10)
        .text(brand.brandName || '', x + 20, boxY + 20);
      doc.fillColor(i === 1 || i === 3 ? 'rgba(255,255,255,0.5)' : C.textLight).font('Helvetica').fontSize(9)
        .text(c, x + 20, boxY + 56);
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 21 — BANNERS
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Banners', 'Event and promotional banners', primary);
    y = 110;
    wrapText(doc, ai.bannerGuidelines || 'Roll-up banners (85x200cm) feature the logo at the top third, key message in the center, and contact information at the bottom. Use the full-color brand palette.', 50, y, { size: 12 });
    y = doc.y + 24;
    doc.rect(170, y, 120, 260).fill(C.gray);
    doc.rect(170, y, 120, 50).fill(primary);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(12).text(brand.brandName || '', 180, y + 16);
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(9).text(brand.tagline || '', 180, y + 80, { width: 100, align: 'center' });
    doc.fillColor(C.textLight).font('Helvetica').fontSize(7).text('www.' + (brand.brandName || 'brand').toLowerCase().replace(/\s/g, '') + '.ae', 180, y + 230, { width: 100, align: 'center' });
    doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text('Roll-up Banner 85×200cm', 170, y + 268);
    doc.rect(330, y, 200, 120).fill(C.sectionBg);
    doc.rect(330, y, 200, 30).fill(primary);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(10).text(brand.brandName || '', 340, y + 8);
    doc.fillColor(C.textLight).font('Helvetica').fontSize(9).text('Event Table Banner', 330, y + 126);
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 22 — SHOWROOM
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Showroom & Entrance', 'Physical space branding', C.black);
    y = 110;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(13).text('Entrance', 50, y);
    wrapText(doc, ai.entranceDesign || 'The entrance features the brand logo as a backlit sign above the door. Floor mats with the brand mark welcome visitors.', 50, y + 18, { size: 11 });
    y = doc.y + 16;
    y = drawSectionDivider(doc, y, 'Showroom');
    wrapText(doc, ai.showroomDesign || 'The showroom uses warm ambient lighting with spotlight accents on hero products. Wall colors match the brand background palette. Product displays use the primary color for accent shelving.', 50, y, { size: 11 });
    y = doc.y + 16;
    y = drawSectionDivider(doc, y, 'Delivery Area');
    wrapText(doc, ai.deliveryBranding || 'Delivery packaging uses branded tape and tissue paper. Vehicles feature the logo on both sides with the tagline below.', 50, y, { size: 11 });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 23 — OFFICE & SPACES
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Office & Spaces', 'Workspace, waiting area, and restroom branding', primary);
    y = 110;
    const spaces = [
      { title: 'Office Space', desc: ai.officeDesign || 'The office uses the brand background color for walls with primary color accent walls in meeting rooms. All signage uses the brand type system.' },
      { title: 'Waiting Area', desc: 'Waiting areas feature the brand story wall with key visuals. Furniture aligns with the brand color palette. Product samples are displayed for visitor interaction.' },
      { title: 'Workshop', desc: 'Workshop areas maintain functional design with brand color coding for zones. Safety signage follows brand typography while meeting regulatory requirements.' },
      { title: 'Restroom', desc: 'Restrooms feature minimal branding — a small logo near the mirror. Soap dispensers and amenities can use branded refills where appropriate.' },
      { title: 'Outdoor Area', desc: ai.outdoorGuidelines || 'Outdoor spaces use weather-resistant signage with the brand logo. Landscaping elements can incorporate the brand accent color in planters and fixtures.' },
    ];
    spaces.forEach((s, i) => {
      y = addPageIfNeeded(doc, y, 80);
      doc.rect(50, y, 495, 4).fill(i === 0 ? primary : C.grayMed);
      y += 10;
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(12).text(s.title, 50, y);
      y += 18;
      wrapText(doc, s.desc, 50, y, { size: 11, color: C.text });
      y = doc.y + 16;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 24 — PRODUCT SPECIFICATION
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Product Specification', 'Fragrance / product details', C.black);
    y = 110;
    if (brand.fragranceNotes) {
      doc.fillColor(C.black).font('Helvetica-Bold').fontSize(13).text('Fragrance Pyramid', 50, y);
      y += 20;
      [['TOP NOTES', brand.fragranceNotes.top], ['HEART NOTES', brand.fragranceNotes.heart], ['BASE NOTES', brand.fragranceNotes.base]].forEach(([k, v]) => {
        doc.rect(50, y, 495, 40).fill(C.gray);
        doc.fillColor(primary).font('Helvetica-Bold').fontSize(9).text(k, 64, y + 8);
        doc.fillColor(C.black).font('Helvetica').fontSize(12).text(v || '', 64, y + 22);
        y += 46;
      });
    }
    y += 8;
    doc.fillColor(C.black).font('Helvetica-Bold').fontSize(13).text('Supplier Brief', 50, y);
    y += 18;
    doc.rect(50, y, 495, 80).fill(C.cream);
    wrapText(doc, brand.supplierBrief || brand.dropshippingBrief || 'Contact Qumak for supplier introductions.', 64, y + 10, { width: 467 });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 25 — FINANCIAL OVERVIEW
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Financial Overview', 'Pricing and margin analysis', primary);
    y = 110;
    const financials = [
      ['Suggested Retail Price', brand.suggestedRetailPrice || '—'],
      ['Cost of Goods (COGS)', brand.estimatedCOGS || brand.estimatedStartupCost || '—'],
      ['Gross Margin', brand.estimatedMargin || '—'],
      ['Est. Monthly Revenue', brand.estimatedMonthlyRevenue || 'AED 40,000–80,000 (month 3)'],
    ];
    financials.forEach(([k, v], i) => {
      doc.rect(50, y, 495, 48).fill(i % 2 === 0 ? C.gray : C.white);
      doc.fillColor(C.textLight).font('Helvetica').fontSize(11).text(k, 64, y + 10);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(16).text(String(v), 64, y + 26);
      y += 52;
    });
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // PAGE 26 — MARKETING KIT
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    drawPageHeader(doc, 'Marketing Kit', 'Ready-to-use copy and content', C.black);
    y = 110;
    const kit = brand.marketingKit || {};
    const marketingItems = [
      ['Instagram Caption', kit.instagramCaption],
      ['TikTok Concept', kit.tiktokScript],
      ['Ad Headline', kit.adHeadline],
      ['Ad Body Copy', kit.adBody],
      ['Email Subject', kit.emailSubject],
      ['SMS / WhatsApp', kit.smsText],
    ].filter(([, v]) => v);

    marketingItems.forEach(([k, v]) => {
      y = addPageIfNeeded(doc, y, 60);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(10).text(k.toUpperCase(), 50, y);
      doc.rect(50, y + 14, 495, 1).fill(C.grayMed);
      wrapText(doc, String(v), 50, y + 20, { width: 495 });
      y = doc.y + 16;
    });

    if (brand.hashtags?.length) {
      y = addPageIfNeeded(doc, y);
      doc.fillColor(primary).font('Helvetica-Bold').fontSize(10).text('HASHTAGS', 50, y);
      y += 16;
      doc.fillColor(C.textLight).font('Helvetica').fontSize(11)
        .text(brand.hashtags.map(h => `#${h}`).join('  '), 50, y, { width: 495 });
    }
    drawPageNumber(doc, pg++);

    // ═══════════════════════════════════════════════════════════
    // BACK COVER
    // ═══════════════════════════════════════════════════════════
    doc.addPage();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.black);
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(42)
      .text(brand.brandName || '', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
    doc.fillColor('rgba(255,255,255,0.4)').font('Helvetica').fontSize(13)
      .text(brand.tagline || '', 0, doc.page.height / 2 - 5, { width: doc.page.width, align: 'center' });
    doc.fillColor('rgba(255,255,255,0.2)').font('Helvetica').fontSize(10)
      .text('Powered by Qumak · qumak.ae', 0, doc.page.height - 60, { width: doc.page.width, align: 'center' });

    doc.end();
  });
}

module.exports = { generateBrandKitPDF };
