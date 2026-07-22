/**
 * load_templates_to_mongo.js
 *
 * Takes the output JSON files from all three ingest scripts
 * and upserts them into MongoDB's generation_templates collection.
 *
 * Run AFTER all three ingest scripts have produced their output files:
 *   node ingest_higgsfield_presets.js --input=./higgsfield_presets_ads.json
 *   node ingest_topview.js --input=./topviewads.json
 *   node ingest_creatify.js --input=./creatify_raw.json
 *   node load_templates_to_mongo.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const INPUT_FILES = [
  { file: './higgsfield_preset_templates.json', label: 'Higgsfield Presets' },
  { file: './topview_templates.json',           label: 'TopView' },
  { file: './creatify_templates.json',          label: 'Creatify' },
];

async function run() {
  const uri = process.env.DB_URL;
  const dbName = process.env.DB || 'qumak';

  if (!uri) {
    console.error('DB_URL not set in .env');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection('generation_templates');

  // Ensure indexes
  await col.createIndex({ source: 1, sourceId: 1 }, { unique: true });
  await col.createIndex({ contentType: 1, isActive: 1 });
  await col.createIndex({ bestCategories: 1, locale: 1, isActive: 1 });
  await col.createIndex({ 'engagement.finalScore': -1 });
  await col.createIndex({ isFeatured: 1, isActive: 1 });
  await col.createIndex({ seasonalPacks: 1 });
  await col.createIndex({ supportedModels: 1 });
  await col.createIndex({ planLevel: 1, isActive: 1 });
  console.log('Indexes ensured');

  let totalUpserted = 0;
  let totalModified = 0;
  let totalErrors = 0;

  for (const { file, label } of INPUT_FILES) {
    const filePath = path.resolve(__dirname, file);
    if (!fs.existsSync(filePath)) {
      console.log(`\nSkipping ${label}: ${file} not found`);
      continue;
    }

    const templates = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`\nLoading ${templates.length} ${label} templates...`);

    const ops = templates.map(t => ({
      updateOne: {
        filter: { source: t.source, sourceId: t.sourceId },
        update: { $set: t, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    }));

    if (ops.length === 0) continue;

    try {
      const result = await col.bulkWrite(ops, { ordered: false });
      console.log(`  ${label}: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
      totalUpserted += result.upsertedCount;
      totalModified += result.modifiedCount;
    } catch (e) {
      if (e.writeErrors) {
        console.error(`  ${label}: ${e.writeErrors.length} errors (others succeeded)`);
        totalErrors += e.writeErrors.length;
      } else {
        console.error(`  ${label}: bulk write failed: ${e.message}`);
        totalErrors++;
      }
    }
  }

  const total = await col.countDocuments();
  const bySource = await col.aggregate([
    { $group: { _id: '$source', count: { $sum: 1 } } },
  ]).toArray();
  const hero = await col.countDocuments({ 'engagement.qualityTier': 'hero' });
  const featured = await col.countDocuments({ 'engagement.qualityTier': 'featured' });
  const withProductSlot = await col.countDocuments({ requiresProductImage: true });
  const withArabic = await col.countDocuments({ 'i18nPrompts.ar': { $ne: null } });

  console.log('\n═══════════════════════════════════');
  console.log('  generation_templates collection');
  console.log('═══════════════════════════════════');
  console.log(`Total documents: ${total}`);
  for (const s of bySource) console.log(`  ${s._id}: ${s.count}`);
  console.log(`Hero tier: ${hero} | Featured: ${featured}`);
  console.log(`Requires product image: ${withProductSlot}`);
  console.log(`Has Arabic prompt: ${withArabic}`);
  console.log(`\nUpserted: ${totalUpserted} | Updated: ${totalModified} | Errors: ${totalErrors}`);

  await client.close();
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
