const emailjs = require("@emailjs/nodejs");

const sendEmail = (templateParams) => {
  const serviceId = process.env.SERVICE_ID;
  const templateId = process.env.TEMPLATE_ID;
  const prolinkPublicKey = process.env.PROLINK_PUBLIC_KEY;
  const prolinkPrivateKey = process.env.PROLINK_PRIVATE_KEY;

  emailjs
    .send(serviceId, templateId, templateParams, {
      publicKey: prolinkPublicKey,
      privateKey: prolinkPrivateKey, // optional, highly recommended for security reasons
    })
    .then(
      (response) => {
        console.log("SUCCESS!", response.status, response.text);
      },
      (err) => {
        console.log("FAILED...", err);
      }
    );
};

module.exports = { sendEmail };
