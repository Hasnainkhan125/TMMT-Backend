const mongoose = require("mongoose");
const { GenerationTemplate } = require('../model/schema/GenerationTemplate');

const connectDB = async (DATABASE_URL, DATABASE, retries = 5) => {
  try {
    const DB_OPTIONS = {
      dbName: DATABASE,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };

    await mongoose.connect(DATABASE_URL, DB_OPTIONS);

    // ✅ Create indexes
    await GenerationTemplate.syncIndexes();
    
    console.log("✅ Database Connected Successfully");
    return true;
  } catch (err) {
    console.log(`❌ Database connection failed (${retries} retries left):`, err.message);
    
    if (retries > 0) {
      console.log(`🔄 Retrying in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      return connectDB(DATABASE_URL, DATABASE, retries - 1);
    }
    
    console.log("❌ All database connection attempts failed");
    return false;
  }
};

module.exports = connectDB;