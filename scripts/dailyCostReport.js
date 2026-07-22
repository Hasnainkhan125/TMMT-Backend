

// scripts/dailyCostReport.js
db.studiojobs.aggregate([
    { $match: { createdAt: { $gte: yesterday } } },
    { $group: { _id: '$modelId', totalUsd: { $sum: '$falCostUsd' }, jobs: { $sum: 1 } } },
    { $sort: { totalUsd: -1 } }
  ]);