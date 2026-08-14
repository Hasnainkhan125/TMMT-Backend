'use strict';

/**
 * brandProjectMigration — utilities to move embedded brand-project data into
 * dedicated sibling collections.
 *
 * Use:
 *   const m = require('./services/brandProjectMigration');
 *   await m.migrateAll(brandProjectId);     // migrate one project
 *   await m.migrateAllProjects();           // migrate every project (idempotent)
 *
 * Safe to run multiple times: each helper checks for existing rows before
 * inserting (per-source fingerprints).
 */

const BrandProject       = require('../model/schema/brandProject');
const BrandLead          = require('../model/schema/brandLead');
const BrandContentItem   = require('../model/schema/brandContentItem');
const BrandAgentMemory   = require('../model/schema/brandAgentMemory');
const BrandAgentInsight  = require('../model/schema/brandAgentInsight');
const BrandSupplier      = require('../model/schema/brandSupplier');
const BrandTradeLicense  = require('../model/schema/brandTradeLicense');

async function migrateLeadsForProject(project) {
  if (!project?.leads?.length) return 0;
  let migrated = 0;
  for (const l of project.leads) {
    const fingerprint = l.email || l.apolloId || `${l.fullName}_${l.company}`;
    if (!fingerprint) continue;
    const existing = await BrandLead.findOne({ brandProject: project._id, $or: [{ email: l.email || null }, { apolloId: l.apolloId || null }] }).lean();
    if (existing) continue;
    await BrandLead.create({ ...l.toObject?.() || l, brandProject: project._id, user: project.user });
    migrated++;
  }
  return migrated;
}

async function migrateContentItemsForProject(project) {
  if (!project?.contentItems?.length) return 0;
  let migrated = 0;
  for (const ci of project.contentItems) {
    const obj = ci.toObject?.() || ci;
    const exists = await BrandContentItem.findOne({
      brandProject: project._id,
      dayNumber: obj.dayNumber,
      platform: obj.platform,
      caption: obj.caption,
    }).lean();
    if (exists) continue;
    await BrandContentItem.create({ ...obj, brandProject: project._id, user: project.user });
    migrated++;
  }
  return migrated;
}

async function migrateContentCalendarForProject(project) {
  if (!project?.contentCalendar?.length) return 0;
  let migrated = 0;
  for (const c of project.contentCalendar) {
    const obj = c.toObject?.() || c;
    const exists = await BrandContentItem.findOne({
      brandProject: project._id,
      dayNumber: obj.dayNumber,
      platform: obj.platform,
      legacy: { $ne: null },
    }).lean();
    if (exists) continue;
    await BrandContentItem.create({
      brandProject: project._id,
      user: project.user,
      platform: obj.platform,
      contentType: 'post',
      status: obj.status === 'posted' ? 'posted' : (obj.status === 'scheduled' ? 'scheduled' : 'draft'),
      caption: obj.caption,
      hashtags: obj.hashtags,
      hook: obj.hook,
      dayNumber: obj.dayNumber,
      scheduledAt: obj.scheduledAt,
      postedAt: obj.postedAt,
      legacy: { sourceField: 'contentCalendar', original: obj },
    });
    migrated++;
  }
  return migrated;
}

async function migrateAgentInsightsForProject(project) {
  if (!project?.agentInsights?.length) return 0;
  let migrated = 0;
  for (const ai of project.agentInsights) {
    const obj = ai.toObject?.() || ai;
    const exists = await BrandAgentInsight.findOne({
      brandProject: project._id,
      agentType: obj.agentType,
      title: obj.title,
    }).lean();
    if (exists) continue;
    await BrandAgentInsight.create({ ...obj, brandProject: project._id, user: project.user });
    migrated++;
  }
  return migrated;
}

async function migrateAgentMemoryForProject(project) {
  if (!project?.agentMemory) return 0;
  const exists = await BrandAgentMemory.findOne({ brandProject: project._id }).lean();
  if (exists) return 0;
  const m = project.agentMemory.toObject?.() || project.agentMemory;
  await BrandAgentMemory.create({ ...m, brandProject: project._id, user: project.user });
  return 1;
}

async function migrateSuppliersForProject(project) {
  const suppliers = project?.businessProfile?.suppliers || [];
  if (!suppliers.length) return 0;
  let migrated = 0;
  for (const s of suppliers) {
    const obj = s.toObject?.() || s;
    if (!obj.name) continue;
    const exists = await BrandSupplier.findOne({ brandProject: project._id, name: obj.name }).lean();
    if (exists) continue;
    await BrandSupplier.create({ ...obj, brandProject: project._id, user: project.user });
    migrated++;
  }
  return migrated;
}

async function migrateTradeLicenseForProject(project) {
  if (!project?.tradeLicenseApplication?.companyName) return 0;
  const exists = await BrandTradeLicense.findOne({ brandProject: project._id }).lean();
  if (exists) return 0;
  const t = project.tradeLicenseApplication.toObject?.() || project.tradeLicenseApplication;
  await BrandTradeLicense.create({ ...t, brandProject: project._id, user: project.user });
  return 1;
}

async function migrateAll(projectIdOrDoc) {
  const project = typeof projectIdOrDoc === 'string' || projectIdOrDoc?._bsontype
    ? await BrandProject.findById(projectIdOrDoc)
    : projectIdOrDoc;
  if (!project) throw new Error('BrandProject not found');
  return {
    leads:           await migrateLeadsForProject(project),
    contentItems:    await migrateContentItemsForProject(project),
    contentCalendar: await migrateContentCalendarForProject(project),
    agentInsights:   await migrateAgentInsightsForProject(project),
    agentMemory:     await migrateAgentMemoryForProject(project),
    suppliers:       await migrateSuppliersForProject(project),
    tradeLicense:    await migrateTradeLicenseForProject(project),
  };
}

async function migrateAllProjects() {
  const cursor = BrandProject.find({}).cursor();
  const totals = { projects: 0, leads: 0, contentItems: 0, contentCalendar: 0, agentInsights: 0, agentMemory: 0, suppliers: 0, tradeLicense: 0 };
  for (let project = await cursor.next(); project != null; project = await cursor.next()) {
    const result = await migrateAll(project);
    totals.projects++;
    for (const k of Object.keys(result)) totals[k] += result[k];
  }
  return totals;
}

module.exports = {
  migrateAll,
  migrateAllProjects,
  migrateLeadsForProject,
  migrateContentItemsForProject,
  migrateContentCalendarForProject,
  migrateAgentInsightsForProject,
  migrateAgentMemoryForProject,
  migrateSuppliersForProject,
  migrateTradeLicenseForProject,
};
