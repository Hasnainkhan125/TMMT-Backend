const fs = require("fs");
const cheerio = require("cheerio");

const html = fs.readFileSync("./res.txt", "utf-8");
const $ = cheerio.load(html);

const results = [];

$("figure").each((_, fig) => {
  const figure = $(fig);

  // 🎯 TITLE (h4)
  const title = figure.find("h4").first().text().trim() || null;

  // 🎯 LABEL (Top Choice / Mixed etc.)
  let label = null;
  figure.find("span").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length < 30) { // filter out garbage spans
      label = text;
    }
  });

  // 🎯 MEDIA (img + video)
  const media = [];

  figure.find("img, video, source").each((_, el) => {
    const src = $(el).attr("src") || null;
    const srcset = $(el).attr("srcset") || null;

    if (src || srcset) {
      media.push({
        tag: el.tagName,
        src,
        srcset,
      });
    }
  });

  results.push({
    title,
    label,
    media,
  });
});


fs.writeFileSync("./results.json", JSON.stringify(results, null, 2));