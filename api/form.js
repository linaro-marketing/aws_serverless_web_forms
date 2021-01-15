"use strict";

const uuid = require("uuid");
const AWS = require("aws-sdk");
AWS.config.setPromisesDependency(require("bluebird"));
const dynamoDb = new AWS.DynamoDB.DocumentClient();

module.exports.submit = (event, context, callback) => {
  // Get the POST request body
  const requestBody = JSON.parse(event.body);
  // Test Attributes
  const name = requestBody.name;
  const email = requestBody.email;
  // Some type validation
  if (
    typeof fullname !== "string" ||
    typeof email !== "string" ||
    typeof experience !== "number"
  ) {
    console.error("Validation Failed");
    callback(new Error("Couldn't submit form because of validation errors."));
    return;
  }
  submitFormEntry(formEntryStruct(name, email))
    .then((res) => {
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
const formEntryStruct = (name, email) => {
  const timestamp = new Date().getTime();
  return {
    id: uuid.v1(),
    name: fullname,
    email: email,
    submittedAt: timestamp,
    updatedAt: timestamp,
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
