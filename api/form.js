"use strict";

const uuid = require("uuid");
const AWS = require("aws-sdk");
AWS.config.setPromisesDependency(require("bluebird"));
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES({
  region: "us-east-1", // Set the region in which SES is configured
});

const sendVerificationEmail = (inputs, templateName, sendTo, formId) => {
  let confirmationEmailLink = `https://pvwhresjz0.execute-api.us-east-1.amazonaws.com/dev/formVerfiy?token=${formId}`;
  let templateData = {
    confirmation_link: confirmationEmailLink,
    name: inputs["name"],
  };
  // Template Params
  const params = {
    Template: templateName,
    Destination: {
      ToAddresses: [sendTo],
    },
    Source: "it-support@linaro.org", // use the SES domain or email verified in your account
    TemplateData: JSON.stringify(templateData || {}),
  };
  // Send the email
  ses.sendTemplatedEmail(params, (err, data) => {
    if (err) {
      console.log(err);
      return false;
    } else {
      return true;
    }
  });
};
module.exports.submit = (event, context, callback) => {
  console.log(event);
  // Get the POST request body
  const requestBody = JSON.parse(event.body);
  // Test Attributes
  const name = requestBody.name;
  const email = requestBody.email;
  // Some type validation
  // Also check that the requestBody has a length > than 0
  if (
    typeof name !== "string" ||
    (typeof email !== "string" && requestBody.length > 0)
  ) {
    console.error("Validation Failed");
    callback(new Error("Couldn't submit form because of validation errors."));
    return;
  }
  submitFormEntry(formEntryStruct(name, email, requestBody))
    .then((res) => {
      // Send the template email
      sendVerificationEmail(requestBody, "confirmation_dev", email, res.id);
      callback(null, {
        statusCode: 200,
        body: JSON.stringify({
          message: `Sucessfully submitted form with email ${email}`,
          formId: res.id,
        }),
      });
    })
    .catch((err) => {
      console.log(err);
      callback(null, {
        statusCode: 500,
        body: JSON.stringify({
          message: `Unable to submit form with email ${email}`,
        }),
      });
    });
};
// Submit Entry to Dynamo DB table.
const submitFormEntry = (formEntry) => {
  console.log("Adding form formEntry to dynamo db...");
  const formEntryInfo = {
    TableName: process.env.ENTRIES_TABLE,
    Item: formEntry,
  };
  return dynamoDb
    .put(formEntryInfo)
    .promise()
    .then((res) => formEntry);
};
const formEntryStruct = (name, email, requestBody) => {
  const timestamp = new Date().getTime();
  return {
    id: uuid.v1(),
    name: name,
    email: email,
    payload: JSON.stringify(requestBody),
    submittedAt: timestamp,
  };
};
module.exports.verify = (event, context, callback) => {
  const response = {
    statusCode: 200,
    body: JSON.stringify({
      message:
        "Email link has been verified and your ticket has been submitted.",
      input: event,
    }),
  };

  callback(null, response);
};
