const mongoose = require("mongoose");
const User = require("../model/schema/user");
const bcrypt = require("bcrypt");
const { GenerationTemplate } = require('../model/schema/GenerationTemplate');

const connectDB = async (DATABASE_URL, DATABASE) => {
  try {
    const DB_OPTIONS = {
      dbName: DATABASE,
    };

    // mongoose.set("strictQuery", false);
    await mongoose.connect(DATABASE_URL, DB_OPTIONS);

      // Indexes are defined in the schema — Mongoose creates them on first connection
    await GenerationTemplate.ensureIndexes();
    console.log("Database Connected Successfully..");
  } catch (err) {
    console.log("Database Not connected", err.message);
  }
};
module.exports = connectDB;
