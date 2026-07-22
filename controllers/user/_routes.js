const express = require("express");
const user = require("./user");
const auth = require("../../middelwares/auth");

const router = express.Router();

router.get("/", auth, user.getUsers);
router.get("/:id", auth, user.getUser);
router.post("/", user.createUser);
router.put("/:id", auth, user.updateUser);
router.delete("/:id", auth, user.deleteUser);
router.delete("/deleteMany", auth, user.deleteMany);

router.get("/:id/entries", auth, user.getUserEntries);
router.get("/:id/stats", auth, user.getUserStats);

// Profile management routes
router.get("/:id/profile", auth, user.getUserProfile);
router.put("/:id/profile", auth, user.updateUserProfile);

// Compliance routes
router.get("/:id/compliance", auth, user.getComplianceStatus);

// Business management routes
router.put("/:id/business", auth, user.updateBusinessInfo);

// Document management routes
router.post("/:id/documents/upload", auth, user.upload.single('document'), user.updateUserDocuments);
router.delete("/:id/documents/:documentId", auth, user.deleteUserDocument);

// Referral system routes
router.get("/referral/dashboard", auth, user.getReferralDashboard);
router.get("/referral/validate/:code", user.validateReferralCode); // Public - used during signup
router.post("/referral/commission/:applicationId", auth, user.processReferralCommission);

// Video review routes
router.post("/video-reviews", auth, user.submitVideoReview);
router.get("/video-reviews", auth, user.getVideoReviews);
router.put("/:userId/video-reviews/:reviewId/approve", auth, user.approveVideoReview);

router.post("/login", user.login);
router.post("/admin-register", user.adminRegister);

router.post(
  "/register",
  auth,
  user.upload.fields([
    { name: "profilePicture", maxCount: 1 },
    { name: "offerLetter", maxCount: 1 },
    { name: "passportCopy", maxCount: 1 },
    { name: "emiratesId", maxCount: 1 },
    { name: "labourCard", maxCount: 1 },
    { name: "visaPage", maxCount: 1 },
  ]),
  user.register
);

router.put(
  "/:id/documents",
  auth,
  user.upload.fields([
    { name: "profilePicture", maxCount: 1 },
    { name: "offerLetter", maxCount: 1 },
    { name: "passportCopy", maxCount: 1 },
    { name: "emiratesId", maxCount: 1 },
    { name: "labourCard", maxCount: 1 },
    { name: "visaPage", maxCount: 1 },
  ]),
  user.updateDocuments
);

router.use("/user-documents", express.static("uploads/User/UserDocuments"));

// Bidding credits & top-up
router.get("/:id/bidding-limit", auth, user.getBiddingLimit);
router.post("/:id/top-up", auth, user.topUpCredits);

module.exports = router;
