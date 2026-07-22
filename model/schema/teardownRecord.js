'use strict';

const mongoose = require('mongoose');

// Each audio segment maps 1:1 to a beat / scene in the spec.
const audioSegmentSchema = new mongoose.Schema({
  beatIndex: Number,
  start:     Number,
  end:       Number,
  r2Key:     String,   // private R2 key — NOT a public URL
  publicUrl: { type: String, default: null },
}, { _id: false });

const teardownRecordSchema = new mongoose.Schema({
  scanId:   { type: mongoose.Schema.Types.ObjectId, ref: 'UrlToAdsScan', index: true },
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  specId:   { type: String, required: true, unique: true, index: true },

  competitor: { type: String, default: null },

  // Private R2 reference to the raw source video.
  // NEVER served publicly — internal training + user replay only.
  sourceVideoR2Key: { type: String, default: null },
  sourceVideoUrl:   { type: String, default: null },  // signed URL (short-lived)

  // Per-beat audio clips sliced from the original audio.
  audioSegments: { type: [audioSegmentSchema], default: [] },

  // Derived signals from the pipeline
  transcript: {
    text:     { type: String, default: '' },
    wordCount:{ type: Number, default: 0 },
    language: { type: String, default: null },
    segments: { type: mongoose.Schema.Types.Mixed, default: [] },
    words:    { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  sceneCount:        { type: Number, default: 0 },
  durationSec:       { type: Number, default: null },
  frameUrls:         [String],
  detectedStructure: { type: String, default: null },
  hookType:          { type: String, default: null },
  triggers:          [String],
  pacing:            { type: String, default: null },
  visionNotes:       { type: String, default: null },

  // The gold: diff between model-proposed beats and what the user shipped.
  // Captured on every PUT /spec/:specId and on confirm.
  userEdits: {
    beatsBefore:   { type: mongoose.Schema.Types.Mixed, default: null },
    beatsAfter:    { type: mongoose.Schema.Types.Mixed, default: null },
    fieldsChanged: [String],
    editCount:     { type: Number, default: 0 },
    editedAt:      { type: Date,   default: null },
  },

  // Outcome link — populated after the user renders a video from this spec.
  renderedAdSetId: { type: String, default: null },

}, {
  timestamps: true,
  collection: 'teardownrecords',
});

module.exports = mongoose.models.TeardownRecord ||
  mongoose.model('TeardownRecord', teardownRecordSchema);
