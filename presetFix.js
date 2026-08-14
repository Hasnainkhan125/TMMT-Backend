const fs = require('fs');

const inputPath = './preset_With_product.json';
const outputPath = './preset_With_product_fixed.json';

function transform(item) {
  return {
    name: item.name || null,
    previewCoverUrl: item.previewCoverUrl || null,
    previewVideoUrl: item.previewVideoUrl || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    ext: Array.isArray(item.ext) ? item.ext : [],
    source: item.source || null,
    status: item.status || null,
    assetType: item.assetType || null,
  };
}

async function run() {
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error('Expected an array');
  }

  const result = data.map(transform);

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`Done. Processed ${result.length} records.`);
}

run();