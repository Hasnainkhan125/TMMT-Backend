const catalog = require('../../services/catalogLoader');
const fs = require('fs');
const path = require('path');

// Response formatter
const formatResponse = (success, message, data = null, errors = null) => ({
  success,
  message,
  data,
  errors,
  meta: {
    timestamp: new Date().toISOString(),
    requestId: Math.random().toString(36).substr(2, 9)
  }
});

// Get all categories
const getCategories = async (req, res) => {
  try {
    const categories = catalog.getCategories();
    res.json(formatResponse(true, 'Categories retrieved successfully', { categories }));
  } catch (error) {
    console.error('Error getting categories:', error);
    res.status(500).json(formatResponse(false, 'Failed to retrieve categories', null, [error.message]));
  }
};

// Get subcategories
const getSubcategories = async (req, res) => {
  try {
    const { category } = req.query;
    const subcategories = catalog.getSubcategories(category);
    res.json(formatResponse(true, 'Subcategories retrieved successfully', { subcategories }));
  } catch (error) {
    console.error('Error getting subcategories:', error);
    res.status(500).json(formatResponse(false, 'Failed to retrieve subcategories', null, [error.message]));
  }
};

// Get services
const getServices = async (req, res) => {
  try {
    const { subcategory, category, limit = 50, offset = 0 } = req.query;
    
    if (!subcategory) {
      return res.status(400).json(formatResponse(false, 'Subcategory parameter is required'));
    }
    
    const services = catalog.getServicesBySubcategory(subcategory, category);
    const total = services.length;
    const paginatedServices = services.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    res.json(formatResponse(true, 'Services retrieved successfully', {
      services: paginatedServices,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + parseInt(limit)) < total
      }
    }));
  } catch (error) {
    console.error('Error getting services:', error);
    res.status(500).json(formatResponse(false, 'Failed to retrieve services', null, [error.message]));
  }
};

// Get service by ID
const getServiceById = async (req, res) => {
  try {
    const service = catalog.getServiceById(req.params.id);
    
    if (!service) {
      return res.status(404).json(formatResponse(false, 'Service not found'));
    }
    
    res.json(formatResponse(true, 'Service retrieved successfully', { service }));
  } catch (error) {
    console.error('Error getting service by ID:', error);
    res.status(500).json(formatResponse(false, 'Failed to retrieve service', null, [error.message]));
  }
};

// Search services
const searchServices = async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q || q.trim().length < 3) {
      return res.status(400).json(formatResponse(false, 'Search query must be at least 3 characters long'));
    }
    
    const services = catalog.searchServices(q.trim(), parseInt(limit));
    
    res.json(formatResponse(true, 'Search completed successfully', {
      services,
      query: q.trim(),
      total: services.length
    }));
  } catch (error) {
    console.error('Error searching services:', error);
    res.status(500).json(formatResponse(false, 'Search failed', null, [error.message]));
  }
};

// Get catalog statistics
const getStats = async (req, res) => {
  try {
    const stats = catalog.getStats();
    res.json(formatResponse(true, 'Statistics retrieved successfully', { stats }));
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json(formatResponse(false, 'Failed to retrieve statistics', null, [error.message]));
  }
};

// Create new service (Admin/Amer only)
const createService = async (req, res) => {
  try {
    const { categorySlug, subcategorySlug } = req.query;
    const serviceData = req.body;
    
    if (!categorySlug || !subcategorySlug) {
      return res.status(400).json(formatResponse(false, 'Category and subcategory slugs are required'));
    }
    
    // Validate required fields
    const requiredFields = ['serviceName', 'outsideDescription'];
    const missingFields = requiredFields.filter(field => !serviceData[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json(formatResponse(false, 'Missing required fields', null, missingFields));
    }
    
    const newService = catalog.addService(categorySlug, subcategorySlug, serviceData);
    
    res.status(201).json(formatResponse(true, 'Service created successfully', { service: newService }));
  } catch (error) {
    console.error('Error creating service:', error);
    res.status(500).json(formatResponse(false, 'Failed to create service', null, [error.message]));
  }
};

// Update service (Admin/Amer only)
const updateService = async (req, res) => {
  try {
    const serviceId = req.params.id;
    const updateData = req.body;
    
    const updatedService = catalog.updateService(serviceId, updateData);
    
    res.json(formatResponse(true, 'Service updated successfully', { service: updatedService }));
  } catch (error) {
    console.error('Error updating service:', error);
    if (error.message === 'Service not found') {
      res.status(404).json(formatResponse(false, error.message));
    } else {
      res.status(500).json(formatResponse(false, 'Failed to update service', null, [error.message]));
    }
  }
};

// Delete service (Admin only)
const deleteService = async (req, res) => {
  try {
    const serviceId = req.params.id;
    
    const deletedService = catalog.deleteService(serviceId);
    
    res.json(formatResponse(true, 'Service deleted successfully', { service: deletedService }));
  } catch (error) {
    console.error('Error deleting service:', error);
    if (error.message === 'Service not found') {
      res.status(404).json(formatResponse(false, error.message));
    } else {
      res.status(500).json(formatResponse(false, 'Failed to delete service', null, [error.message]));
    }
  }
};

// Reload services from file (Admin only)
const reloadServices = async (req, res) => {
  try {
    catalog.reloadData();
    const stats = catalog.getStats();
    
    res.json(formatResponse(true, 'Services reloaded successfully', { stats }));
  } catch (error) {
    console.error('Error reloading services:', error);
    res.status(500).json(formatResponse(false, 'Failed to reload services', null, [error.message]));
  }
};

// Create backup of services file (Admin only)
const backupServices = async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.resolve(process.cwd(), 'backups');
    const backupFile = path.join(backupDir, `services-backup-${timestamp}.json`);
    const sourceFile = path.resolve(process.cwd(), 'assets/services.json');
    
    // Ensure backup directory exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // Copy the file
    fs.copyFileSync(sourceFile, backupFile);
    
    res.json(formatResponse(true, 'Backup created successfully', {
      backupFile: path.basename(backupFile),
      timestamp
    }));
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json(formatResponse(false, 'Failed to create backup', null, [error.message]));
  }
};

// Restore services from backup (Admin only)
const restoreServices = async (req, res) => {
  try {
    const { backupFile } = req.body;
    
    if (!backupFile) {
      return res.status(400).json(formatResponse(false, 'Backup file name is required'));
    }
    
    const backupPath = path.resolve(process.cwd(), 'backups', backupFile);
    const targetPath = path.resolve(process.cwd(), 'assets/services.json');
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json(formatResponse(false, 'Backup file not found'));
    }
    
    // Validate JSON before restoring
    const backupContent = fs.readFileSync(backupPath, 'utf-8');
    JSON.parse(backupContent); // Will throw if invalid JSON
    
    // Copy backup to main file
    fs.copyFileSync(backupPath, targetPath);
    
    // Reload catalog
    catalog.reloadData();
    
    res.json(formatResponse(true, 'Services restored successfully from backup', {
      backupFile,
      restoredAt: new Date().toISOString()
    }));
  } catch (error) {
    console.error('Error restoring services:', error);
    res.status(500).json(formatResponse(false, 'Failed to restore services', null, [error.message]));
  }
};

module.exports = {
  getCategories,
  getSubcategories,
  getServices,
  getServiceById,
  searchServices,
  getStats,
  createService,
  updateService,
  deleteService,
  reloadServices,
  backupServices,
  restoreServices
}; 