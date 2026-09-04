require("dotenv").config();

module.exports = {
  PORT: process.env.PORT || 4000,
  JWT_SECRET: process.env.JWT_SECRET || "lwf-eloued-change-this-secret-in-production",
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || "admin",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "LWF@2026",
  MAX_UPLOAD_MB: 8,

  // MongoDB Atlas — persistent database (replaces the old local db.json file)
  MONGODB_URI: process.env.MONGODB_URI || "",

  // Cloudinary — persistent file storage (replaces the old local uploads/ folder)
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
};
