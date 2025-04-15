"use strict";

const fs = require("fs");
const AWS = require("aws-sdk");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const nv = require("node-vault");
var aws4 = require("aws4");
AWS.config.setPromisesDependency(require("bluebird"));
const ses = new AWS.SES({
  region: "us-east-1",
});

const vault = nv({
  apiVersion: "v1",
  endpoint: `https://${process.env.VAULT_DOMAIN}:${process.env.VAULT_PORT}`,
});
vault.generateFunction("awsIamLogin", {
  method: "POST",
  path: "/auth/aws/login",
});

const vaultLogin = async () => {
  const postBody = await getSignedAWSLoginConfig(
    process.env.VAULT_IAM_ROLE,
    process.env.VAULT_DOMAIN
  );
  return await vault.awsIamLogin(postBody);
};

const getSignedAWSLoginConfig = (role, id) => {
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
  for (let header in headers) {
    headers[header] = [headers[header].toString()];
  }

  return {
    role: role,
    iam_http_request_method: "POST",
    iam_request_url: Buffer.from(url, "utf8").toString("base64"),
    iam_request_body: Buffer.from(body, "utf8").toString("base64"),
    iam_request_headers: Buffer.from(JSON.stringify(headers), "utf8").toString(
      "base64"
    ),
  };
};

const sendVerificationEmail = (inputs, templateName, sendTo, formId, event) => {
  let templateData = {
    name: inputs["customfield_13155"],
    description: inputs["description"] ?? inputs["customfield_13365"],
  };

  const params = {
    Template: templateName,
    Destination: {
      ToAddresses: [sendTo],
    },
    Source: process.env.VERIFICATION_FROM_EMAIL_ADDR,
    TemplateData: JSON.stringify(templateData || {}),
  };

  ses.sendTemplatedEmail(params, (err, data) => {
    if (err) {
      console.log("Error whilst sending email:", err);
      return false;
    } else {
      console.log("Confirmation Email Sent");
      return true;
    }
  });
};

const validateForm = (formData) => {
  let form_id = formData["form_id"];
  let validFormData = fetchFormData(form_id);
  if (!validFormData) {
    console.log("Couldn't fetch form_data for the form_id provided.");
    return false;
  } else {
    const validRequiredRequestFields =
      validFormData.fields.requestTypeFields.filter((entry) => {
        return entry.required === true;
      });
    for (let i = 0; i < validRequiredRequestFields.length; i++) {
      if (!formData.hasOwnProperty(validRequiredRequestFields[i].fieldId)) {
        console.log("Missing a required field.");
        return false;
      }
    }
    if (!formData.hasOwnProperty("email")) {
      console.log("Missing the email field.");
      return false;
    }
  }
  return true;
};

const serviceDeskRequest = (
  endpoint,
  method,
  password,
  payload = false,
  experimental = false
) => {
  const requestHeaders = {
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
  return fetch(
    `https://${process.env.SERVICE_DESK_DOMAIN}${endpoint}`,
    requestHeaders
  );
};

const getServiceDeskUserAccount = async (form_submission_data, secret) => {
  console.log("Fetching SD user account...: ");
  const sdResponse = await serviceDeskRequest(
    `/rest/api/3/user/search?query=${form_submission_data.email}`,
    "GET",
    secret
  );

  if (!sdResponse.ok) {
    if (sdResponse.status !== 404) {
      throw new Error(
        `HTTP status ${sdResponse.status}: FailedToAddUserToServiceDeskProject}`
      );
    }
  }

  const jsonRes = await sdResponse.json();
  if (jsonRes.length === 0) {
    console.log("User account not found, creating customer account...");
    const full_name = form_submission_data.email;
    const createCustomerRes = await serviceDeskRequest(
      `/rest/servicedeskapi/customer`,
      "POST",
      secret,
      { email: form_submission_data.email, displayName: full_name },
      true
    );

    if (!createCustomerRes.ok) {
      throw new Error(
        `HTTP status ${createCustomerRes.status}: FailedToCreateUserAsNewCustomer`
      );
    }

    return await createCustomerRes.json();
  } else {
    return jsonRes[0];
  }
};

const addUserToServiceDeskProject = async (formData, user, secret) => {
  const res = await serviceDeskRequest(
    `/rest/servicedeskapi/servicedesk/${formData.projectId}/customer`,
    "POST",
    secret,
    { accountIds: [user.accountId] },
    true
  );

  if (!res.ok) {
    throw new Error(
      `HTTP status ${res.status}: FailedToAddUserToServiceDeskProject`
    );
  }
};

const createServiceDeskRequest = async (
  form_submission_data,
  formData,
  secret
) => {
  let preparedSubmissionData = { ...form_submission_data };
  if (preparedSubmissionData.formName) {
    delete preparedSubmissionData.formName;
  }
  let requestEmail = preparedSubmissionData["email"];
  delete preparedSubmissionData["email"];
  delete preparedSubmissionData["form_id"];
  const payload = {
    serviceDeskId: formData.projectId,
    requestTypeId: formData.requestTypeId,
    requestFieldValues: preparedSubmissionData,
    raiseOnBehalfOf: requestEmail,
  };
  console.log("CreateServiceDeskRequestPayload: ", payload);

  const res = await serviceDeskRequest(
    `/rest/servicedeskapi/request`,
    "POST",
    secret,
    payload
  );
  console.log("result", res);

  if (!res.ok) {
    throw new Error(
      `HTTP status ${res.status}: FailedToCreateServiceDeskRequest`
    );
  }

  return await res.json();
};
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
const submitTicket = async (form_submission_data, event) => {
  console.log("Submitting Ticket...", form_submission_data);
  const formData = fetchFormData(form_submission_data.form_id.toString());
  console.log("Form Data: ", formData);
  const authResult = await vaultLogin();
  try {
    vault.token = authResult.auth.client_token;
    const result = await vault.read(process.env.VAULT_SECRET_PATH);
    console.log("Auth successful...");
    const secret = result.data.pw;
    const user = await getServiceDeskUserAccount(form_submission_data, secret);
    await addUserToServiceDeskProject(formData, user, secret);
    console.log("User added to Service Desk Project");
    await createServiceDeskRequest(form_submission_data, formData, secret);
    console.log("Service desk ticket created...");
  } finally {
    await vault.tokenRevokeSelf();
  }
};

module.exports.submit = async (event, context, callback) => {
  try {
    const form_submission_data = JSON.parse(event.body);
    var formValid = validateForm(form_submission_data);

    if (!formValid) {
      console.error("Validation Failed");
      throw new Error("FormValidationFailed");
    } else {
      await submitTicket(form_submission_data, event);
      await sendVerificationEmail(
        form_submission_data,
        "confirmation_dev",
        form_submission_data.email,
        form_submission_data.form_id,
        event
      );
      callback(null, {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({
          message: `Sucessfully submitted form with email ${form_submission_data.email}`,
          formId: form_submission_data.form_id,
        }),
      });
    }
  } catch (error) {
    console.error("Error during submission:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({
        message: "An error occurred while processing the submission.",
        error: error.message,
      }),
    };
  }
};
