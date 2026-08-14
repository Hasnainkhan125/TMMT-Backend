const cheerio = require("cheerio");
const fs = require("fs");


const getAssets = async () => {
    const html = fs.readFileSync("./higss.html", "utf8");
  const $ = cheerio.load(html);

  const urls = new Set();

  const add = (url) => {
    if (!url) return;

    // remove whitespace
    url = url.trim();

    // ignore empty/js links
    if (
      !url ||
      url.startsWith("javascript:") ||
      url.startsWith("#")
    ) {
      return;
    }

    urls.add(url);
  };

  // --------------------------
  // href attributes
  // --------------------------
  $("a, link").each((_, el) => {
    add($(el).attr("href"));
  });

  // --------------------------
  // src attributes
  // --------------------------
  $(
    "img, script, iframe, source, video, audio, track, embed"
  ).each((_, el) => {
    add($(el).attr("src"));
  });

  // --------------------------
  // parse srcset
  // ex:
  // img1.jpg 1x, img2.jpg 2x
  // --------------------------
  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");

    if (!srcset) return;

    srcset
      .split(",")
      .map((entry) => entry.trim())
      .forEach((entry) => {
        const url = entry.split(/\s+/)[0];
        add(url);
      });
  });

  // --------------------------
  // SVG references
  // --------------------------

  // img src ending in .svg
  $('img[src$=".svg"]').each((_, el) => {
    add($(el).attr("src"));
  });

  // inline SVG image href
  $("svg image").each((_, el) => {
    add($(el).attr("href"));
    add($(el).attr("xlink:href"));
  });

  // svg use refs
  $("svg use").each((_, el) => {
    add($(el).attr("href"));
    add($(el).attr("xlink:href"));
  });

  // --------------------------
  // metadata / important assets
  // --------------------------

  // favicon
  $('link[rel*="icon"]').each((_, el) => {
    add($(el).attr("href"));
  });

  // canonical
  $('link[rel="canonical"]').each((_, el) => {
    add($(el).attr("href"));
  });

  // preload assets
  $('link[rel="preload"]').each((_, el) => {
    add($(el).attr("href"));
  });

  // OpenGraph / social preview images
  $('meta[property^="og:"], meta[name^="twitter:"]').each(
    (_, el) => {
      add($(el).attr("content"));
    }
  );

  // --------------------------
  // CSS background-image urls
  // --------------------------
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");

    const matches =
      style?.match(/url\((['"]?)(.*?)\1\)/g) || [];

    matches.forEach((m) => {
      const url = m.replace(
        /url\((['"]?)(.*?)\1\)/,
        "$2"
      );

      add(url);
    });
  });

  return [...urls];
};


// usage
const assets =  getAssets().then((data)=>{
    fs.writeFileSync("./higgs.json", JSON.stringify(data, null, 2));
});