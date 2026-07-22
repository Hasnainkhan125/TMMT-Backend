// services/resolver/steps/extractTechStack.js
const { detectPlatform, detectFramework, detectHosting } = require('../utils/patternMatchers');
const cheerio = require('cheerio');

function extractTechStack(html, responseHeaders, renderedHtml = null) {
  const searchText = [html, renderedHtml || ''].join('\n');
  const $ = cheerio.load(html);
  
  const platform = detectPlatform(searchText);
  const frameworks = detectFramework(searchText);
  const hosting = detectHosting(responseHeaders);
  
  // Payment processors
  const paymentTech = [];
  if (/stripe\.com|checkout\.stripe\.com|js\.stripe\.com/.test(searchText)) paymentTech.push('stripe');
  if (/checkout\.com|cko\.scripts\.com/.test(searchText)) paymentTech.push('checkout.com');
  if (/paypal\.com\/sdk/.test(searchText)) paymentTech.push('paypal');
  if (/paddle\.com/.test(searchText)) paymentTech.push('paddle');
  if (/telr\.com/.test(searchText)) paymentTech.push('telr');  // UAE-relevant
  if (/payfort\.com/.test(searchText)) paymentTech.push('payfort');
  if (/tabby\.ai/.test(searchText)) paymentTech.push('tabby');
  if (/tamara\.co/.test(searchText)) paymentTech.push('tamara');
  
  // Reviews / UGC
  const reviewsTech = [];
  if (/reviews\.io|widget\.reviews\.io/.test(searchText)) reviewsTech.push('reviews.io');
  if (/cdn-widgetsrepository\.yotpo\.com/.test(searchText)) reviewsTech.push('yotpo');
  if (/staticw2\.yotpo\.com/.test(searchText)) reviewsTech.push('yotpo');
  if (/trustpilot\.com\/bootstrap/.test(searchText)) reviewsTech.push('trustpilot');
  if (/judge\.me/.test(searchText)) reviewsTech.push('judge.me');
  if (/okendo\.io/.test(searchText)) reviewsTech.push('okendo');
  
  // Shipping/logistics
  const shippingTech = [];
  if (/shippo|shipstation|easypost/.test(searchText)) shippingTech.push('shipping_platform');
  if (/aftership/.test(searchText)) shippingTech.push('aftership');
  
  // Product recommendations / personalization
  const personalizationTech = [];
  if (/nosto\.com/.test(searchText)) personalizationTech.push('nosto');
  if (/recombee/.test(searchText)) personalizationTech.push('recombee');
  if (/dynamicyield/.test(searchText)) personalizationTech.push('dynamic_yield');
  
  // Search
  const searchTech = [];
  if (/algolia/.test(searchText)) searchTech.push('algolia');
  if (/typesense/.test(searchText)) searchTech.push('typesense');
  if (/searchspring/.test(searchText)) searchTech.push('searchspring');
  
  return {
    platform,
    cms: platform === 'wordpress' || platform === 'ghost' ? platform : null,
    frameworks,
    hosting,
    paymentTech,
    reviewsTech,
    shippingTech,
    personalizationTech,
    searchTech,
  };
}

module.exports = { extractTechStack };