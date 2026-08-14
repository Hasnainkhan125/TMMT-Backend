const fs = require('fs');
const path = require('path');

let cache = null;
let indexed = null;

class ServicesCatalog {
  constructor() {
    this.filePath = path.resolve(process.cwd(), 'assets/services.json');
    this.loadData();
  }

  loadData() {
    try {
      const text = fs.readFileSync(this.filePath, 'utf-8');
      cache = JSON.parse(text);
      this.buildIndex();
      return cache;
    } catch (error) {
      console.error('Error loading services.json:', error);
      cache = [];
      indexed = {};
      return cache;
    }
  }

  saveData() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(cache, null, 2), 'utf-8');
      this.buildIndex();
      return true;
    } catch (error) {
      console.error('Error saving services.json:', error);
      return false;
    }
  }

  buildIndex() {
    indexed = {
      categories: new Map(),
      subcategories: new Map(),
      services: new Map(),
      servicesBySubcategory: new Map(),
      searchIndex: new Map()
    };

    if (!cache || !Array.isArray(cache)) return;

    cache.forEach(category => {
      // Index category
      indexed.categories.set(category.sub1Slug, {
        id: category.sub1Recordid,
        name: category.sub1ServiceName,
        slug: category.sub1Slug,
        description: category.categoryTag,
        image: category.sub1ImageSrc,
        pageUrl: category.page_url,
        position: category.position,
        isPublic: category.IsPublic,
        isFeatured: category.IsFeatured
      });

      // Index subcategories
      if (category.subCategory && Array.isArray(category.subCategory)) {
        category.subCategory.forEach(sub => {
          const subKey = `${category.sub1Slug}_${sub.sub2Slug}`;
          indexed.subcategories.set(subKey, {
            id: sub.sub2RecordId,
            name: sub.sub2ServiceName,
            slug: sub.sub2Slug,
            categorySlug: category.sub1Slug,
            description: sub.sub2Description,
            image: sub.sub2ImgSrc,
            pageUrl: sub.page_url,
            position: sub.position,
            isPublic: sub.IsPublic,
            isFeatured: sub.IsFeatured,
            minimumPrice: sub.minimumPrice
          });

          // Index services
          if (sub.services && Array.isArray(sub.services)) {
            sub.services.forEach(service => {
              const serviceKey = `${category.sub1Slug}_${sub.sub2Slug}_${service.Recordid}`;
              const requiredDocs = this.extractRequiredDocuments(service.FormDescription);
              
              const serviceData = {
                id: service.Recordid,
                serviceId: service.ServiceId,
                name: service.serviceName,
                slug: service.serviceSub2Slug,
                categorySlug: category.sub1Slug,
                subcategorySlug: sub.sub2Slug,
                image: service.imageSrc,
                noOfApplications: service.noOfApplication,
                insideDescription: service.insideDescription,
                outsideDescription: service.outsideDescription,
                outsideDescriptionArray: service.outsideDescriptionArray,
                formDescription: service.FormDescription,
                aboutDescription: service.AboutDescription,
                prices: service.prices || [],
                requiredDocuments: requiredDocs,
                numberOfOptions: service.numberOfOptions,
                tooltipData: service.tooltipData,
                isPackage: service.isPackage,
                isModel: service.isModel
              };

              indexed.services.set(serviceKey, serviceData);
              
              // Index by subcategory
              if (!indexed.servicesBySubcategory.has(subKey)) {
                indexed.servicesBySubcategory.set(subKey, []);
              }
              indexed.servicesBySubcategory.get(subKey).push(serviceData);

              // Build search index
              const searchTerms = [
                service.serviceName,
                category.sub1ServiceName,
                sub.sub2ServiceName,
                service.outsideDescription,
                ...requiredDocs
              ].filter(Boolean).join(' ').toLowerCase();

              searchTerms.split(/\s+/).forEach(term => {
                if (term.length > 2) {
                  if (!indexed.searchIndex.has(term)) {
                    indexed.searchIndex.set(term, new Set());
                  }
                  indexed.searchIndex.get(term).add(serviceKey);
                }
              });
            });
          }
        });
      }
    });
  }

  stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  extractRequiredDocuments(html) {
    if (!html) return [];
    const items = [];
    const regex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const text = this.stripHtml(match[1] || '');
      if (text && !text.toLowerCase().includes('note:') && !text.toLowerCase().includes('fees')) {
        items.push(text);
      }
    }
    return items;
  }

  // Public API methods
  getCategories() {
    if (!indexed) this.buildIndex();
    return Array.from(indexed.categories.values()).sort((a, b) => a.position - b.position);
  }

  getSubcategories(categorySlug = null) {
    if (!indexed) this.buildIndex();
    let subcategories = Array.from(indexed.subcategories.values());
    
    if (categorySlug) {
      subcategories = subcategories.filter(sub => sub.categorySlug === categorySlug);
    }
    
    return subcategories.sort((a, b) => a.position - b.position);
  }

  getServicesBySubcategory(subcategorySlug, categorySlug = null) {
    if (!indexed) this.buildIndex();
    
    for (const [key, services] of indexed.servicesBySubcategory) {
      const [catSlug, subSlug] = key.split('_');
      if (subSlug === subcategorySlug && (!categorySlug || catSlug === categorySlug)) {
        return services;
      }
    }
    return [];
  }

  getServiceById(serviceId) {
    if (!indexed) this.buildIndex();
    
    for (const service of indexed.services.values()) {
      if (service.id == serviceId || service.serviceId == serviceId) {
        return service;
      }
    }
    return null;
  }

  searchServices(query, limit = 10) {
    if (!indexed || !query) return [];
    
    const queryTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
    const matchingServiceKeys = new Set();
    
    queryTerms.forEach(term => {
      for (const [indexTerm, serviceKeys] of indexed.searchIndex) {
        if (indexTerm.includes(term) || term.includes(indexTerm)) {
          serviceKeys.forEach(key => matchingServiceKeys.add(key));
        }
      }
    });

    const results = Array.from(matchingServiceKeys)
      .map(key => indexed.services.get(key))
      .filter(Boolean)
      .slice(0, limit);

    return results;
  }

  // CRUD operations
  addService(categorySlug, subcategorySlug, serviceData) {
    if (!cache) this.loadData();
    
    const category = cache.find(cat => cat.sub1Slug === categorySlug);
    if (!category) throw new Error('Category not found');
    
    const subcategory = category.subCategory?.find(sub => sub.sub2Slug === subcategorySlug);
    if (!subcategory) throw new Error('Subcategory not found');
    
    const newId = Math.max(...cache.flatMap(cat => 
      cat.subCategory?.flatMap(sub => 
        sub.services?.map(s => s.Recordid) || []
      ) || []
    ), 0) + 1;

    const newService = {
      serviceSub2Slug: subcategorySlug,
      isPackage: serviceData.isPackage || false,
      isModel: serviceData.isModel || true,
      Recordid: newId,
      serviceName: serviceData.serviceName,
      noOfApplication: serviceData.noOfApplication || "0 Process",
      imageSrc: serviceData.imageSrc || "",
      imgAlt: serviceData.imgAlt || null,
      imgTitle: serviceData.imgTitle || null,
      RecordId: newId,
      ServiceId: newId,
      insideDescription: serviceData.insideDescription || "",
      outsideDescription: serviceData.outsideDescription || "",
      FormDescription: serviceData.FormDescription || "",
      AboutDescription: serviceData.AboutDescription || "",
      insidePageDescription: serviceData.insidePageDescription || null,
      prices: serviceData.prices || [],
      tooltipData: serviceData.tooltipData || null,
      numberOfOptions: serviceData.prices?.length || 1,
      maxSaving: serviceData.maxSaving || null,
      outsideDescriptionArray: serviceData.outsideDescriptionArray || []
    };

    if (!subcategory.services) subcategory.services = [];
    subcategory.services.push(newService);
    
    this.saveData();
    return newService;
  }

  updateService(serviceId, serviceData) {
    if (!cache) this.loadData();
    
    for (const category of cache) {
      if (!category.subCategory) continue;
      
      for (const subcategory of category.subCategory) {
        if (!subcategory.services) continue;
        
        const serviceIndex = subcategory.services.findIndex(s => s.Recordid == serviceId || s.ServiceId == serviceId);
        if (serviceIndex !== -1) {
          subcategory.services[serviceIndex] = { ...subcategory.services[serviceIndex], ...serviceData };
          this.saveData();
          return subcategory.services[serviceIndex];
        }
      }
    }
    
    throw new Error('Service not found');
  }

  deleteService(serviceId) {
    if (!cache) this.loadData();
    
    for (const category of cache) {
      if (!category.subCategory) continue;
      
      for (const subcategory of category.subCategory) {
        if (!subcategory.services) continue;
        
        const serviceIndex = subcategory.services.findIndex(s => s.Recordid == serviceId || s.ServiceId == serviceId);
        if (serviceIndex !== -1) {
          const deletedService = subcategory.services.splice(serviceIndex, 1)[0];
          this.saveData();
          return deletedService;
        }
      }
    }
    
    throw new Error('Service not found');
  }

  getStats() {
    if (!indexed) this.buildIndex();
    
    return {
      totalCategories: indexed.categories.size,
      totalSubcategories: indexed.subcategories.size,
      totalServices: indexed.services.size,
      lastUpdated: fs.statSync(this.filePath).mtime
    };
  }
}

// Singleton instance
const catalogInstance = new ServicesCatalog();

module.exports = {
  getCategories: () => catalogInstance.getCategories(),
  getSubcategories: (categorySlug) => catalogInstance.getSubcategories(categorySlug),
  getServicesBySubcategory: (subcategorySlug, categorySlug) => catalogInstance.getServicesBySubcategory(subcategorySlug, categorySlug),
  getServiceById: (serviceId) => catalogInstance.getServiceById(serviceId),
  searchServices: (query, limit) => catalogInstance.searchServices(query, limit),
  addService: (categorySlug, subcategorySlug, serviceData) => catalogInstance.addService(categorySlug, subcategorySlug, serviceData),
  updateService: (serviceId, serviceData) => catalogInstance.updateService(serviceId, serviceData),
  deleteService: (serviceId) => catalogInstance.deleteService(serviceId),
  getStats: () => catalogInstance.getStats(),
  reloadData: () => catalogInstance.loadData()
}; 