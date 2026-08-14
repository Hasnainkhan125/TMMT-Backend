const BlogPost = require('../../model/schema/blogPost');
const catchAsync = require('../../utills/catchAsync');
const AppError = require('../../utills/appError');

// ─── Public ───────────────────────────────────────────────────────────────────

exports.listPublished = catchAsync(async (req, res) => {
  const { page = 1, limit = 12 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const filter = { publishedAt: { $lte: new Date() } };
  const total = await BlogPost.countDocuments(filter);
  const posts = await BlogPost.find(filter)
    .sort({ publishedAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .select('title slug excerpt coverImage publishedAt tags featured author');

  res.status(200).json({
    status: 'success',
    results: posts.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    data: { posts },
  });
});

exports.getBySlug = catchAsync(async (req, res, next) => {
  const post = await BlogPost.findOne({
    slug: req.params.slug,
    publishedAt: { $lte: new Date() },
  });

  if (!post) return next(new AppError('Blog post not found', 404));

  res.status(200).json({ status: 'success', data: { post } });
});

// ─── Admin ─────────────────────────────────────────────────────────────────────

exports.adminList = catchAsync(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const total = await BlogPost.countDocuments({});
  const posts = await BlogPost.find({})
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .select('title slug excerpt coverImage publishedAt tags featured author createdAt');

  res.status(200).json({
    status: 'success',
    results: posts.length,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    data: { posts },
  });
});

exports.adminCreate = catchAsync(async (req, res) => {
  const { title, slug, excerpt, content, coverImage, featured, publishedAt, tags, author } = req.body;
  const post = await BlogPost.create({
    title, slug, excerpt, content, coverImage,
    featured: !!featured,
    publishedAt: publishedAt ? new Date(publishedAt) : undefined,
    tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
    author,
  });
  res.status(201).json({ status: 'success', data: { post } });
});

exports.adminUpdate = catchAsync(async (req, res, next) => {
  const { title, slug, excerpt, content, coverImage, featured, publishedAt, tags, author } = req.body;
  const post = await BlogPost.findByIdAndUpdate(
    req.params.id,
    {
      title, slug, excerpt, content, coverImage,
      featured: !!featured,
      publishedAt: publishedAt ? new Date(publishedAt) : null,
      tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      author,
    },
    { new: true, runValidators: true }
  );
  if (!post) return next(new AppError('Post not found', 404));
  res.status(200).json({ status: 'success', data: { post } });
});

exports.adminDelete = catchAsync(async (req, res, next) => {
  const post = await BlogPost.findByIdAndDelete(req.params.id);
  if (!post) return next(new AppError('Post not found', 404));
  res.status(204).json({ status: 'success', data: null });
});
