// src/lib/adBrain.js
const AD_TEMPLATES = {
    gym: {
      visual: "dark industrial gym, dramatic side lighting, rim light on athlete",
      camera: "low angle push-in, rack focus during rep, POV perspective",
      grade: "deep blacks, teal highlights, high contrast",
      motion: "slow motion 120fps on peak moment",
      emotion: "grit, determination, breakthrough",
    },
    perfume: {
      visual: "extreme macro glass bottle, light refracting, luxury studio",
      camera: "macro push-in, liquid slow-motion 240fps, model proximity",
      grade: "warm cream gold, deep blacks, soft diffusion",
      motion: "240fps liquid pour, fabric movement",
      emotion: "desire, mystery, luxury identity",
    },
    skincare: {
      visual: "clean beauty skincare products, minimalist design, natural lighting",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "soft pastel colors, natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "calm, confidence, natural beauty",
    },
    electronics: {
      visual: "high-tech electronic devices, minimalist design, dark background",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "deep blacks, high contrast, subtle highlights",
      motion: "slow motion product usage, subtle electronic movement",
      emotion: "innovation,科技感, sleek design",
    },
    custom: {
      visual: "custom product, user-provided description, natural lighting",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "custom color palette, natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "custom emotion, custom brand identity",
    },
    food: {
      visual: "food product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural food identity",
    },
    fashion: {
      visual: "fashion product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural fashion identity",
    },
    services: {
      visual: "service product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural services identity",
    },
    retail: {
      visual: "retail product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural retail identity",
    },
    supplements: {
      visual: "supplement product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural supplements identity",
    },
    wellness: {
      visual: "wellness product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural wellness identity",
    },
    beauty: {
      visual: "beauty product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural beauty identity",
    },
    clothing: {
      visual: "clothing product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural clothing identity",
    },
    jewelry: {
      visual: "jewelry product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural jewelry identity",
    },
    home: {
      visual: "home product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural home identity",
    },
    realEstate: {
      visual: "real estate product, natural lighting, minimalist design",
      camera: "low angle shot, product close-up, subtle depth of field",
      grade: "natural skin tones, subtle highlights",
      motion: "slow motion product application, subtle fabric movement",
      emotion: "natural beauty, confidence, natural real estate identity",
    },
    // ... all 6 categories
  };
  
  export function buildPrompt(category, userDescription, brandName) {
    const template = AD_TEMPLATES[category];
    if (!template) throw new Error("Unknown category");
    
    return `cinematic ${category} advertisement for ${brandName}, ${userDescription}, 
    ${template.visual}, ${template.camera}, 
    color grade: ${template.grade}, ${template.motion}, 
    emotion: ${template.emotion}, 
    professional commercial quality, 16:9 letterbox format, 
    ultra-high production value, no text overlays`;
  }