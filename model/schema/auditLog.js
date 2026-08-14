const mongoose = require('mongoose');
const crypto = require('crypto');

// Actor schema for tracking who performed the action
const actorSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['user', 'system', 'admin', 'api', 'compliance', 'investor', 'issuer'],
    required: true
  },
  id: {
    type: String,
    default: null  // wallet address, user ID, or system identifier
  },
  wallet_address: {
    type: String,
    default: null,
    lowercase: true,
    match: /^0x[a-fA-F0-9]{40}$/
  },
  ip_address: {
    type: String,
    default: null
  },
  user_agent: {
    type: String,
    default: null
  }
}, { _id: false });

// Entity reference schema for tracking what was affected
const entitySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'order', 'payment', 'allocation', 'token', 'claim', 'kyc', 'investor', 
      'spv', 'distribution', 'corporate_action', 'compliance_rule', 'user', 'system',
      'visa_application', 'notification'
    ],
    required: true
  },
  id: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: null
  }
}, { _id: false });

// Diff schema for before/after tracking
const diffSchema = new mongoose.Schema({
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  changes: [{
    field: String,
    old_value: mongoose.Schema.Types.Mixed,
    new_value: mongoose.Schema.Types.Mixed
  }]
}, { _id: false });

// Main audit log schema
const auditLogSchema = new mongoose.Schema({
  // Core audit information
  action: {
    type: String,
    required: true,
    enum: [
      // Order lifecycle
      'ORDER_CREATE', 'ORDER_UPDATE', 'ORDER_STATUS_CHANGE', 'ORDER_CANCEL',
      // Payment operations
      'PAYMENT_SUBMIT', 'PAYMENT_CONFIRM', 'PAYMENT_FAIL', 'PAYMENT_REFUND',
      // Token operations
      'TOKEN_MINT', 'TOKEN_TRANSFER', 'TOKEN_BURN', 'TOKEN_PAUSE', 'TOKEN_UNPAUSE',
      // Allocation & Settlement
      'ALLOCATION_CREATE', 'ALLOCATION_APPROVE', 'ALLOCATION_SETTLE', 'ALLOCATION_FAIL',
      // KYC & Compliance
      'KYC_SUBMIT', 'KYC_APPROVE', 'KYC_REJECT', 'KYC_UPDATE',
      'CLAIM_ADD', 'CLAIM_REMOVE', 'CLAIM_VERIFY',
      'ELIGIBILITY_CHECK', 'COMPLIANCE_REVIEW',
      // Investor operations
      'INVESTOR_CREATE', 'INVESTOR_UPDATE', 'INVESTOR_SUSPEND', 'INVESTOR_ACTIVATE',
      'INVESTOR_CLASSIFICATION_UPDATE', 'INVESTOR_SANCTIONS_SCREEN',
      // SPV operations
      'SPV_CREATE', 'SPV_UPDATE', 'SPV_DIRECTOR_ADD', 'SPV_DIRECTOR_REMOVE',
      'SPV_LICENSE_ADD', 'SPV_LICENSE_EXPIRE',
      // Corporate actions
      'DISTRIBUTION_CREATE', 'DISTRIBUTION_EXECUTE', 'DISTRIBUTION_CANCEL',
      'CORPORATE_ACTION_CREATE', 'CORPORATE_ACTION_EXECUTE',
      // System operations
      'USER_LOGIN', 'USER_LOGOUT', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE',
      'SYSTEM_CONFIG_CHANGE', 'COMPLIANCE_RULE_UPDATE',
      // Reporting
      'REPORT_GENERATE', 'REPORT_EXPORT', 'DATA_EXPORT',
      // Other
      'OTHER'
    ],
    index: true
  },
  
  // Who performed the action
  actor: {
    type: actorSchema,
    required: true
  },
  
  // What was affected
  entity: {
    type: entitySchema,
    required: true
  },
  
  // Change tracking
  diff: {
    type: diffSchema,
    default: null
  },
  
  // Request context
  request_id: {
    type: String,
    required: true,
    index: true
  },
  session_id: {
    type: String,
    default: null
  },
  correlation_id: {
    type: String,
    default: null
  },
  
  // Timestamp
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  
  // Jurisdictional context
  jurisdiction: {
    type: String,
    default: null,
    length: 2,
    uppercase: true
  },
  
  // Risk assessment
  risk_level: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical', null],
    default: null
  },
  
  // Compliance context
  regulatory_event: {
    type: Boolean,
    default: false,
    index: true
  },
  requires_reporting: {
    type: Boolean,
    default: false
  },
  
  // Result information
  result: {
    type: String,
    enum: ['success', 'failure', 'partial', 'pending'],
    required: true,
    default: 'success'
  },
  error_code: {
    type: String,
    default: null
  },
  error_message: {
    type: String,
    default: null
  },
  
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  tags: [{
    type: String,
    trim: true
  }],
  
  // Tamper evidence - hash chaining
  hash_chain_prev: {
    type: String,
    default: null,
    index: true
  },
  hash_chain_current: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Retention and archival
  retention_period_days: {
    type: Number,
    default: 2555  // 7 years default
  },
  archived: {
    type: Boolean,
    default: false,
    index: true
  },
  archived_at: {
    type: Date,
    default: null
  }
}, {
  timestamps: false,  // We use our own timestamp field
  collection: 'audit_logs'
});

// Indexes for efficient querying
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ 'actor.type': 1, 'actor.id': 1, timestamp: -1 });
auditLogSchema.index({ 'actor.wallet_address': 1, timestamp: -1 });
auditLogSchema.index({ 'entity.type': 1, 'entity.id': 1, timestamp: -1 });
auditLogSchema.index({ jurisdiction: 1, timestamp: -1 });
auditLogSchema.index({ regulatory_event: 1, timestamp: -1 });
auditLogSchema.index({ risk_level: 1, timestamp: -1 });
auditLogSchema.index({ request_id: 1 });
auditLogSchema.index({ tags: 1 });

// Virtual for human-readable timestamp
auditLogSchema.virtual('formatted_timestamp').get(function() {
  return this.timestamp.toISOString();
});

// Methods
auditLogSchema.methods.generateHash = function() {
  const data = {
    action: this.action,
    actor: this.actor,
    entity: this.entity,
    timestamp: this.timestamp.getTime(),
    diff: this.diff,
    result: this.result,
    prev: this.hash_chain_prev || ''
  };
  
  const dataString = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHash('sha256').update(dataString).digest('hex');
};

auditLogSchema.methods.verifyIntegrity = function() {
  const calculatedHash = this.generateHash();
  return calculatedHash === this.hash_chain_current;
};

// Statics for creating audit entries
auditLogSchema.statics.createEntry = async function(data) {
  const {
    action,
    actor,
    entity,
    diff = null,
    request_id,
    session_id = null,
    correlation_id = null,
    jurisdiction = null,
    risk_level = null,
    regulatory_event = false,
    requires_reporting = false,
    result = 'success',
    error_code = null,
    error_message = null,
    metadata = {},
    tags = []
  } = data;
  
  // Get the last audit log for hash chaining
  const lastLog = await this.findOne({}, {}, { sort: { timestamp: -1 } });
  const hash_chain_prev = lastLog ? lastLog.hash_chain_current : null;
  
  // Create the log entry
  const logEntry = new this({
    action,
    actor,
    entity,
    diff,
    request_id,
    session_id,
    correlation_id,
    jurisdiction,
    risk_level,
    regulatory_event,
    requires_reporting,
    result,
    error_code,
    error_message,
    metadata,
    tags,
    hash_chain_prev,
    timestamp: new Date()
  });
  
  // Generate and set the current hash
  logEntry.hash_chain_current = logEntry.generateHash();
  
  return await logEntry.save();
};

auditLogSchema.statics.verifyChainIntegrity = async function(startDate = null, endDate = null) {
  const query = {};
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = startDate;
    if (endDate) query.timestamp.$lte = endDate;
  }
  
  const logs = await this.find(query).sort({ timestamp: 1 });
  const issues = [];
  
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    
    // Verify individual hash
    if (!log.verifyIntegrity()) {
      issues.push({
        type: 'hash_mismatch',
        log_id: log._id,
        timestamp: log.timestamp,
        action: log.action
      });
    }
    
    // Verify chain linkage
    if (i > 0) {
      const prevLog = logs[i - 1];
      if (log.hash_chain_prev !== prevLog.hash_chain_current) {
        issues.push({
          type: 'chain_break',
          log_id: log._id,
          prev_log_id: prevLog._id,
          timestamp: log.timestamp,
          action: log.action
        });
      }
    }
  }
  
  return {
    verified: issues.length === 0,
    total_logs: logs.length,
    issues: issues
  };
};

// Pre-save middleware to ensure hash is set
auditLogSchema.pre('save', function(next) {
  if (!this.hash_chain_current) {
    this.hash_chain_current = this.generateHash();
  }
  next();
});

// Prevent modifications to existing audit logs
auditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function(next) {
  return next(new Error('Audit logs cannot be modified'));
});

auditLogSchema.pre('deleteOne', function(next) {
  return next(new Error('Audit logs cannot be deleted'));
});

auditLogSchema.pre('deleteMany', function(next) {
  return next(new Error('Audit logs cannot be deleted'));
});

// Ensure virtual fields are serialized
auditLogSchema.set('toJSON', { virtuals: true });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog; 