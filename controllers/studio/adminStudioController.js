'use strict';

const StudioJob = require('../../model/schema/studioJob');
const DailyStat = require('../../model/schema/dailyStat');
const Lead = require('../../model/schema/lead');
const AdBrainFeedback = require('../../model/schema/adBrainFeedback');
const StudioAsset = require('../../model/schema/studioAsset');

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * GET /api/v1/studio/admin/stats
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const today = getTodayString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalJobs,
      todayStat,
      recentFailures,
      categoryBreakdown,
      activeJobCount,
      // New analytics
      avgRatingByCategory,
      leadsThisWeek,
      totalLeads,
      convertedLeads,
      completedAssets,
      downloadedAssets,
      sharedAssets,
      regenJobs
    ] = await Promise.all([
      // Existing
      StudioJob.countDocuments(),
      DailyStat.findOne({ date: today }).lean(),
      StudioJob.find({ status: 'failed', createdAt: { $gte: sevenDaysAgo } })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('category error createdAt')
        .lean(),
      StudioJob.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]),
      StudioJob.countDocuments({ status: { $in: ['queued', 'generating', 'postprocessing'] } }),

      // Quality: avg rating grouped by category
      AdBrainFeedback.aggregate([
        { $group: { _id: '$category', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]),

      // Acquisition: leads this week
      Lead.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Lead.countDocuments(),
      Lead.countDocuments({ isConverted: true }),

      // Asset engagement
      StudioAsset.countDocuments({ status: 'completed' }),
      StudioAsset.countDocuments({ downloadCount: { $gt: 0 } }),
      StudioAsset.countDocuments({ shareCode: { $ne: null } }),

      // Regen rate: jobs with parentJobId stored in extras
      StudioJob.countDocuments({ 'userInputs.extras.parentJobId': { $exists: true } })
    ]);

    // Shape quality signals
    const ratingMap = {};
    avgRatingByCategory.forEach(item => {
      ratingMap[item._id] = { avgRating: Math.round(item.avgRating * 100) / 100, count: item.count };
    });

    const categoryMap = {};
    categoryBreakdown.forEach(item => { categoryMap[item._id] = item.count; });

    const totalCompleted = Object.values(categoryMap).reduce((a, b) => a + b, 0);

    return res.json({
      success: true,
      stats: {
        // Core
        totalJobs,
        activeJobs: activeJobCount,
        today: todayStat || { totalJobs: 0, completedJobs: 0, failedJobs: 0, totalFalCost: 0 },
        categoryBreakdown: categoryMap,
        recentFailures: recentFailures.map(f => ({
          category: f.category,
          errorMessage: f.error?.message || 'Unknown error',
          createdAt: f.createdAt
        })),

        // Quality signals
        avgRatingByCategory: ratingMap,
        regenRateByCategory: totalCompleted > 0
          ? { total: regenJobs, rate: Math.round((regenJobs / totalCompleted) * 100) / 100 }
          : { total: 0, rate: 0 },

        // Acquisition
        leadsThisWeek,
        leadConversionRate: totalLeads > 0
          ? Math.round((convertedLeads / totalLeads) * 1000) / 1000
          : 0,

        // Asset engagement
        shareClickRate: completedAssets > 0
          ? Math.round((sharedAssets / completedAssets) * 1000) / 1000
          : 0,
        downloadRate: completedAssets > 0
          ? Math.round((downloadedAssets / completedAssets) * 1000) / 1000
          : 0
      }
    });
  } catch (err) {
    console.error('[adminStudioController] getDashboardStats error:', err);
    return res.status(500).json({ success: false, error: 'server_error', message: 'Failed to fetch stats.' });
  }
};
