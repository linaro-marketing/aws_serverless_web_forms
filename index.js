"use strict";

const fs = require("fs");
const uuid = require("uuid");
const AWS = require("aws-sdk");
const fetch = require("node-fetch");
const nv = require("node-vault");
var aws4 = require("aws4");
AWS.config.setPromisesDependency(require("bluebird"));
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const ses = new AWS.SES({
  region: "us-east-1", // Set the region in which SES is configured
});

const vault = nv({
  apiVersion: "v1",
  endpoint: `https://${process.env.VAULT_DOMAIN}:${process.env.VAULT_PORT}`,
});
vault.generateFunction("awsIamLogin", {
  method: "POST",
  path: "/auth/aws/login",
});

//NOTE: I'm using async/await
const vaultLogin = async () => {
  // check if we are already logged in and have a token
  const postBody = await getSignedAWSLoginConfig(
    process.env.VAULT_IAM_ROLE,
    process.env.VAULT_DOMAIN
  ); //role and request ID moved inside
  return await vault.awsIamLogin(postBody);
};
function getSignedAWSLoginConfig(role, id) {
  var body = "Action=GetCallerIdentity&Version=2011-06-15";
  var url = "https://sts.amazonaws.com/";
  var signedRequest;
  if (id) {
    signedRequest = aws4.sign({
      service: "sts",
      headers: { "X-Vault-AWS-IAM-Server-ID": id },
      body: body,
    });
  } else {
    signedRequest = aws4.sign({ service: "sts", body: body });
  }
  var headers = signedRequest.headers;
  var header;
  for (header in headers) {
    if (typeof headers[header] === "number") {
      headers[header] = headers[header].toString();
    }
    headers[header] = [headers[header]];
  }
  var request_url = new Buffer.from(url, "utf8");
  var iam_request_body = new Buffer.from(body, "utf8");
  var iam_request_headers = new Buffer.from(JSON.stringify(headers), "utf8");
  return {
    role: role,
    iam_http_request_method: "POST",
    iam_request_url: request_url.toString("base64"),
    iam_request_body: iam_request_body.toString("base64"),
    iam_request_headers: iam_request_headers.toString("base64"),
  };
}
const sendVerificationEmail = (inputs, templateName, sendTo, formId, event) => {
  let confirmationEmailLink = `https://${event.requestContext.domainName}/${event.requestContext.stage}/formVerify?token=${formId}`;
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
    Source: process.env.VERIFICATION_FROM_EMAIL_ADDR, // use the SES domain or email verified in your account
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
/**
 * Submit Entry to Dynamo DB table.
 * @param {Object} formEntry - formEntryStruct() object.
 * @returns {Promise} - Returns a dynamoDb promise.
 */
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
/**
 * Creates an Object with neccessary dynamoDb attributes.
 * @param {string} email - The email address of the form submitter
 * @param {Object} requestBody - The validated requestBody object
 * @returns {Object} - Returns an object ready to be added to dynamoDb
 */
const formEntryStruct = (origin, email, requestBody) => {
  const timestamp = new Date().getTime();
  return {
    id: uuid.v1(),
    email: email,
    website: origin,
    payload: JSON.stringify(requestBody),
    submittedAt: timestamp,
  };
};

/**
 * Updates a table entry value.
 * @param {*} uniqueId The unique `id` value of the table entry
 * @param {*} attribute The attribute to update
 * @param {*} value The value to update it with.
 * @param {*} table The name of the DynamoDB table.
 * @returns {Promise} A promise of updating the table entry.
 */
const updateSubmission = (uniqueId, attribute, value, table) => {
  var params = {
    TableName: table,
    Key: { id: uniqueId },
    UpdateExpression: "set #a = :x",
    ConditionExpression: "attribute_not_exists (verified)",
    ExpressionAttributeNames: { "#a": attribute },
    ExpressionAttributeValues: {
      ":x": value,
    },
  };
  return dynamoDb.update(params).promise();
};
// Verify the submission by finding a dynamoDb entry
// with an id equal to that of the GET token param.
const verifySubmission = async (token) => {
  // Query params with "token"
  let params = {
    TableName: process.env.ENTRIES_TABLE,
    Key: {
      id: token,
    },
  };
  console.log(params);
  // Get the current item based on id.
  return dynamoDb.get(params).promise();
};
// Delete the submission from dynamo DB once the request has been submitted
// successfully.
const deleteSubmission = (event) => {
  console.log("Deleting submission entry...");
  if (!event.queryStringParameters.token) return false;
  let token = event.queryStringParameters.token;
  // Query params with "token"
  let params = {
    TableName: process.env.ENTRIES_TABLE,
    Key: {
      id: token,
    },
  };
  console.log(params);
  return dynamoDb.delete(params).promise();
};
/**
 * Service Desk Request helper function which
 * returns a node-fetch promise.
 * @param {string} endpoint - The Service Desk Rest API endpoint e.g. /rest/api/2/user
 * @param {string} method - The request method e.g POST / GET
 * @param {string} password - The Service Desk account password. Username is provided via process.env.SERVICE_DESK_USERNAME
 * @param {Object} payload - An optional payload for the body of the request.
 * @param {Object} experimental - A boolean value to determine wheter to include the X-ExperimentalApi header.
 * @returns {Promise} - Returns a node-fetch fetch() promise
 */
const serviceDeskRequest = (
  endpoint,
  method,
  password,
  payload = false,
  experimental = false
) => {
  var requestHeaders = {
    method: method,
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.SERVICE_DESK_USERNAME}:${password}`
        ).toString("base64"),
      "Content-Type": "application/json",
    },
  };
  if (payload) {
    requestHeaders.body = JSON.stringify(payload);
  }
  if (experimental) {
    requestHeaders["headers"]["X-ExperimentalApi"] = true;
  }
  console.log(requestHeaders);
  return fetch(
    `https://${process.env.SERVICE_DESK_DOMAIN}${endpoint}`,
    requestHeaders
  );
};
/**
 * Returns the Service Desk user account for the given email
 * and creates a new account if one does not already exist.
 * @param {Object} form_submission_data - The form submission data object which must contain the email/name attributes
 * @param {string} secret - The Service Desk account password. Username is provided via process.env.SERVICE_DESK_USERNAME
 * @returns {Promise} - Returns a node-fetch fetch() promise of the SD user data
 */
const getServiceDeskUserAccount = async (form_submission_data, secret) => {
  console.log("Fetching user SD user account...");
  var sdResponse = await serviceDeskRequest(
    `/rest/api/2/user?username=${form_submission_data.email}`,
    "GET",
    secret
  );
  if (!sdResponse.ok) {
    // Check the response is not 404 since this represents the
    // user was not found.
    if (sdResponse.status !== 404) {
      throw new Error(
        `HTTP status ${sdResponse.status}: FailedToAddUserToServiceDeskProject}`
      );
    }
  }
  var jsonRes = await sdResponse.json();
  // User not found so create an account
  if (jsonRes.hasOwnProperty("errorMessages")) {
    console.log("User account not found, creating customer account...");
    var full_name = `${form_submission_data.name}`;
    var createCustomerRes = await serviceDeskRequest(
      `/rest/servicedeskapi/customer`,
      "POST",
      secret,
      { email: form_submission_data.email, fullName: full_name },
      true
    );
    return await createCustomerRes.json();
  } else {
    return jsonRes;
  }
};
/**
 * Adds a user to the specified Service Desk Project
 * @param {Object} user - The user data object which must contain an emailAddress
 * @param {string} secret - The Service Desk account password. Username is provided via process.env.SERVICE_DESK_USERNAME
 * @returns {Promise} - Returns a node-fetch fetch() promise of the SD user data
 */
const addUserToServiceDeskProject = async (formData, user, secret) => {
  // Add the customer to the service desk project for the current form submitted
  console.log(
    `Adding customer account to the ${formData.projectName} project...`
  );
  // Make the request to add the user to the project based on the form_id provided in the form submission.
  var res = await serviceDeskRequest(
    `/rest/servicedeskapi/servicedesk/${formData.projectId}/customer`,
    "POST",
    secret,
    {
      usernames: [user.emailAddress],
    },
    true
  );
  if (!res.ok) {
    throw new Error(
      `HTTP status ${res.status}: FailedToAddUserToServiceDeskProject}`
    );
  }
  return await res.json();
};
/**
 * Adds a user to the specified Service Desk Project
 * @param {String} form_id - The form_id of the relevant request. See form_data.json
 * @returns {Object} - Returns the relevant form data.
 */
const fetchFormData = (form_id) => {
  let rawFormData = fs.readFileSync("form_data.json");
  let tempformData = JSON.parse(rawFormData);
  var foundForm = false;
  var formData = {};
  tempformData.forEach((form, index) => {
    if (form.form_id.toString() === form_id) {
      formData = form;
      foundForm = true;
    }
  });
  return foundForm ? formData : false;
};
/**
 * Creates the Service Desk Request
 * @param {Object} form_submission_data - The details of the form submission from dynamoDb
 * @returns {Object} - Returns the relevant form data.
 */
const createServiceDeskRequest = async (
  form_submission_data,
  formData,
  secret
) => {
  // https://docs.atlassian.com/jira-servicedesk/REST/3.6.2/#servicedeskapi/request-createCustomerRequest
  let preparedSubmissionData = form_submission_data;
  let requestEmail = preparedSubmissionData["email"];
  delete preparedSubmissionData["email"];
  delete preparedSubmissionData["form_id"];
  // Prepare any checkbox values for ticket submission.
  // https://docs.atlassian.com/jira-servicedesk/REST/3.6.2/#fieldformats
  for (const key in preparedSubmissionData) {
    if (Array.isArray(preparedSubmissionData[key])) {
      let mappedVals = [];
      for (let i = 0; i < preparedSubmissionData[key].length; i++) {
        mappedVals.push({ id: preparedSubmissionData[key][i] });
      }
      preparedSubmissionData[key] = mappedVals;
    }
  }
  let payload = {
    serviceDeskId: formData.projectId,
    requestTypeId: formData.requestTypeId,
    requestFieldValues: preparedSubmissionData,
    raiseOnBehalfOf: requestEmail,
  };
  console.log("Submitted payload: ", payload);
  var res = await serviceDeskRequest(
    `/rest/servicedeskapi/request`,
    "POST",
    secret,
    payload
  );
  if (!res.ok) {
    console.log("response text: ", res);
    console.log("Creating service desk request: ", res);
    // Check the response is not 404 since this represents the
    // user was not found.
    if (res.status !== 404) {
      throw new Error(
        `HTTP status ${res.status}: FailedToCreateServiceDeskRequest}`
      );
    }
  }
  return await res.json();
};
/**
 * Main submit ticket logic
 * @param {Object} data - The details of the form submission from dynamoDb
 * @returns {Object} - Returns the relevant form data.
 */
const submitTicket = async (form_submission_data, event) => {
  // Fetch form_data.json based on form_id.
  var formData = fetchFormData(form_submission_data.form_id.toString());
  console.log("Form Data: ", formData);
  // Login to vault and then submit the ticket via:
  // 1. Checking if the email provided is already a customer on Service Desk
  // 1.1 If the user is not a customer, create the customer
  // 2. Add the customer account to the Service Desk project based on the form_id
  // 3. Submit a new request based on the request type provided.
  const authResult = await vaultLogin();
  try {
    console.log(authResult);
    vault.token = authResult.auth.client_token;
    var secret = "";
    var result = await vault.read(process.env.VAULT_SECRET_PATH);
    secret = result.data.pw;
    var user = await getServiceDeskUserAccount(form_submission_data, secret);
    // Add user to the service desk project
    await addUserToServiceDeskProject(formData, user, secret);
    // Create the request ticket
    var res = await createServiceDeskRequest(
      form_submission_data,
      formData,
      secret
    );
    console.log(res);
    // await deleteSubmission(event);
  } finally {
    await vault.tokenRevokeSelf();
  }
};

/**
 * Take the form data and attempt to collect required form verification
 * email inputs. E.g a name.
 * @param {Object} formData - The formSubmission data object.
 * @returns {Object} - Returns an object containing neccessary inputs for
 *  verification email
 */
const getVerificationEmailTemplateInputs = (formData) => {
  // Get the submissions form_id.
  let form_id = formData["form_id"];
  // Let's fetch the form data from form_data.json
  let validFormData = fetchFormData(form_id);
  var firstName = "";
  var familyName = "";
  var fullName = "";
  for (let i = 0; i < validFormData.fields.requestTypeFields.length; i++) {
    // Field name contains "Name"
    if (
      formData.hasOwnProperty(
        validFormData.fields.requestTypeFields[i].name.indexOf("Name") > -1
      )
    ) {
      var fieldName = validFormData.fields.requestTypeFields[i].name.trim();
      if (fieldName === "Family Name") {
        familyName = fieldName;
      } else if (fieldName === "First Name") {
        firstName = fieldName;
      }
    }
  }
  if (firstName !== "" && familyName !== "") {
    fullName = `${firstName} ${familyName}`;
  }
  return { name: firstName, familyName: familyName, fullName: fullName };
};
//
/**
 * Validate the form agains the local form_data.json file.
 * @param {Object} formData - The formSubmission data object.
 * @returns {Boolean} - If the form data is valid return true else
 * return false.
 */
const validateForm = (formData) => {
  // Get the submissions form_id.
  let form_id = formData["form_id"];
  // Let's fetch the form data from form_data.json
  let validFormData = fetchFormData(form_id);
  // Check that the form data is returned.
  if (!validFormData) {
    console.log("Couldn't fetch form_data for the form_id provided.");
    return false;
  } else {
    // Form id exists - let's check the other values
    const validRequiredRequestFields = validFormData.fields.requestTypeFields.filter(
      (entry) => {
        return entry.required === true;
      }
    );
    // Check the form submission contains the required fields.
    for (let i = 0; i < validRequiredRequestFields.length; i++) {
      if (!formData.hasOwnProperty(validRequiredRequestFields[i].fieldId)) {
        console.log("Missing a required field.");
        return false;
      }
    }
    // Check the form submission has an email property.
    if (!formData.hasOwnProperty("email")) {
      console.log("Missing the email field.");
      return false;
    }
  }
  return true;
};
/**
 * Publishes a message to our form service sns topic.
 * @param {string} message - The message to publish to sns.
 * @returns {Promise} - Returns a promise.
 */
const publishSNSMessage = (message) => {
  // Setup params
  var params = {
    Message: message,
    TopicArn: process.env.SNS_TOPIC_ARN,
  };
  return new AWS.SNS({ apiVersion: "2010-03-31" }).publish(params).promise();
};
/**
 * Function handler for the verification of a submission. Runs when a form confirmation
 * link is clicked.
 * @param {*} event
 * @param {*} context
 * @param {*} callback
 */
module.exports.verify = async (event, context, callback) => {
  try {
    console.log(event);
    console.log("Verifying the submission...");
    if (!event.queryStringParameters.token) {
      callback(null, {
        statusCode: 500,
        body: JSON.stringify({
          message: "Invalid token provided.",
        }),
      });
    }
    const verifyRes = await verifySubmission(event.queryStringParameters.token);
    console.log(verifyRes);
    if (verifyRes.hasOwnProperty("Item")) {
      console.log("valid");
      const res = await updateSubmission(
        event.queryStringParameters.token,
        "verified",
        "VERIFIED",
        process.env.ENTRIES_TABLE
      );
      console.log(res);
      console.log("Setting the status of submission to verified.");
      // Parse the response
      const formDataFromDB = JSON.parse(verifyRes.Item.payload);
      console.log(formDataFromDB);
      // Submit the ticket with data from dynamoDB
      await submitTicket(formDataFromDB, event);
      // Format a redirection url
      console.log("Form Data from DB: ", formDataFromDB);
      console.log("Email: ", formDataFromDB.email);
      var redirection_url = `${verifyRes.Item.website}/thank-you/?email=${formDataFromDB.email}`;
      callback(null, {
        statusCode: 301,
        headers: {
          Location: redirection_url,
        },
      });
    } else {
      callback(null, {
        statusCode: 301,
        headers: {
          Location: "https://www.linaro.org/thank-you/",
        },
      });
    }
  } catch (err) {
    console.log(err.message);
    // Catch the failure of the conditional update request.
    if (err.message === "The conditional request failed") {
      callback(null, {
        statusCode: 301,
        headers: {
          Location: "https://www.linaro.org/thank-you/",
        },
      });
    }
    await publishSNSMessage(err.message);
    callback(null, {
      statusCode: 500,
      body: JSON.stringify({
        message: err,
      }),
    });
  }
};
module.exports.submit = async (event, context, callback) => {
  try {
    console.log(event);
    // Get the POST request body
    const requestBody = JSON.parse(event.body);
    // Some type validation
    var formValid = validateForm(requestBody);
    // Also check that the requestBody has a length > than 0
    if (!formValid) {
      console.error("Validation Failed");
      throw new Error("FormValidationFailed");
    } else {
      var inputs = getVerificationEmailTemplateInputs(requestBody);
      var formEntry = await submitFormEntry(
        formEntryStruct(event.headers.origin, requestBody["email"], requestBody)
      );
      // Send the template email
      await sendVerificationEmail(
        { name: inputs["fullName"] },
        "confirmation_dev",
        requestBody["email"],
        formEntry.id,
        event
      );
      callback(null, {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({
          message: `Sucessfully submitted form with email ${requestBody["email"]}`,
          formId: formEntry.id,
        }),
      });
    }
  } catch (err) {
    console.log(err.message);
    await publishSNSMessage(err.message);
    callback(null, {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({
        message: `${err}`,
      }),
    });
  }
};
