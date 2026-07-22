const express = require("express");
const router = express.Router();

const userRoute = require("./user/_routes");
const visaRoutes = require('./visa/_routes');
const authRoutes = require('./auth/_routes');
const chatRoutes = require('./chat/_routes');
const servicesRoutes = require('./services/_routes');
const leadsRoutes = require('./brandProject/leadsRoutes');

//Api`s
router.use("/user", userRoute);
router.use('/auth', authRoutes);
router.use('/visa', visaRoutes);
router.use('/chat', chatRoutes);
router.use('/services', servicesRoutes);
router.use('/leads', leadsRoutes);

module.exports = router;
