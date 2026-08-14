const sgMail = require("@sendgrid/mail");
const dotenv = require("dotenv");
dotenv.config();
const sendGridApiKey = process.env.SENDGRID_API_KEY;

sgMail.setApiKey(`${sendGridApiKey}`);

// const msg = {
//   to: 'reignrealestatead@gmail.com',
//   from: 'synapses1230975@gmail.com', // Use the email address or domain you verified above
//   subject: 'Lead Created',
//   text: 'A lead has been created kindly check the dashboard',
//   html: '<strong>and easy to do anywhere, even with Node.js</strong>',
      // template_id: "d-08bbcfc4d1cd4b859f024e391434979a"
// };



const sendMail = async ({ to, subject, template_id, dynamic_data }) => {
  try {
    const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject,
    templateId: template_id,
    dynamicTemplateData: dynamic_data
  };
  const response = await sgMail.send(msg);
  console.log("sendMail response: ", response[0].statusCode);
  console.log("sendMail response headers: ", response[0].headers);
  console.log("sendMail response body: ", response[0].body);
  return response[0];
  } catch (error) {
    console.error("catch error: ", error?.response?.body);
  }
  // return sgMail
  //   .send(msg)
  //   .then((response) => {
  //     console.log(response[0].statusCode);
  //     console.log(response[0].headers);
  //     console.log(response[0].body),"sendMail body: ";
  //     return response[0];
  //   })
  //   .catch((error) => {
  //     console.error("catch error: ", error?.response?.body);
  //   });
};
module.exports = { sendMail };