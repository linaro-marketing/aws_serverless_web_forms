"use strict";

const fs = require("fs");
const AWS = require("aws-sdk");

AWS.config.setPromisesDependency(require("bluebird"));
const ses = new AWS.SES({
  region: "us-east-1",
});

const FORM_DATA = JSON.parse(fs.readFileSync("form_data.json", "utf8"));

const sendConfirmationEmail = async (inputs, templateName, sendTo) => {
  const templateData = {
    name: inputs["customfield_13155"],
    description: inputs["description"] ?? inputs["customfield_13365"],
  };

  const params = {
    Template: templateName,
    Destination: { ToAddresses: [sendTo] },
    Source: process.env.VERIFICATION_FROM_EMAIL_ADDR,
    TemplateData: JSON.stringify(templateData),
  };

  await ses.sendTemplatedEmail(params).promise();
  console.log("Confirmation Email Sent");
};

const validateForm = (formData, submission) => {
  if (!formData) return false;

  const requiredFields = formData.fields.requestTypeFields.filter(
    (f) => f.required
  );

  for (const field of requiredFields) {
    const value = submission[field.fieldId];
    if (value === undefined || value === null || value === "") {
      return false;
    }
  }

  return "email" in submission;
};

const atlassianRequest = async (
  endpoint,
  method,
  password,
  payload = null,
  experimental = false
) => {
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(`${process.env.SERVICE_DESK_USERNAME}:${password}`).toString(
        "base64"
      ),
    "Content-Type": "application/json",
  };

  if (experimental) {
    headers["X-ExperimentalApi"] = "true";
  }

  const res = await fetch(
    `https://${process.env.SERVICE_DESK_DOMAIN}${endpoint}`,
    {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    }
  );

  const contentType = res.headers.get("content-type") || "";
  const rawBody = await res.text();

  if (!res.ok) {
    throw new Error(
      `Atlassian API error ${res.status} ${method} ${endpoint}\n` +
        rawBody.slice(0, 500)
    );
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `Expected JSON from Atlassian but got ${contentType} from ${endpoint}\n` +
        rawBody.slice(0, 500)
    );
  }

  try {
    return JSON.parse(rawBody);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from Atlassian\n` + e + rawBody.slice(0, 500)
    );
  }
};
const getServiceDeskUserAccount = async (form_submission_data, secret) => {
  console.log("Fetching SD user account...");

  const result = await atlassianRequest(
    ` /rest/api/3/user/search?query=${form_submission_data.email}`,
    "GET",
    secret
  );

  if (!result.values || result.values.length === 0) {
    console.log("User not found, creating customer...");

    return await atlassianRequest(
      `/rest/servicedeskapi/customer`,
      "POST",
      secret,
      {
        email: form_submission_data.email,
        displayName: form_submission_data.email,
      },
      true
    );
  }

  return result.values[0];
};

const addUserToServiceDeskProject = async (formData, user, secret) => {
  await atlassianRequest(
    `/rest/servicedeskapi/servicedesk/${formData.projectId}/customer`,
    "POST",
    secret,
    { accountIds: [user.accountId] },
    true
  );
};

const createServiceDeskRequest = async (
  form_submission_data,
  formData,
  secret
) => {
  const preparedSubmissionData = { ...form_submission_data };

  const requestEmail = preparedSubmissionData.email;
  delete preparedSubmissionData.email;
  delete preparedSubmissionData.form_id;
  // delete preparedSubmissionData["frc-captcha-solution"];
  const payload = {
    serviceDeskId: formData.projectId,
    requestTypeId: formData.requestTypeId,
    requestFieldValues: preparedSubmissionData,
    raiseOnBehalfOf: requestEmail,
  };

  console.log("CreateServiceDeskRequestPayload:", payload);

  return await atlassianRequest(
    `/rest/servicedeskapi/request`,
    "POST",
    secret,
    payload
  );
};

const fetchFormData = (form_id) => {
  const id = form_id.toString();
  return FORM_DATA.find((form) => form.form_id.toString() === id) || null;
};

const submitTicket = async (form_submission_data) => {
  console.log("Submitting Ticket...", form_submission_data);
  const formData = fetchFormData(form_submission_data.form_id);
  if (!formData) {
    throw new Error(`Unknown form_id ${form_submission_data.form_id}`);
  }
  console.log("Form Data: ", formData);
  try {
    const secret = process.env.SERVICE_DESK_API_KEY;
    if (!secret) {
      throw new Error("Missing SERVICE_DESK_API_KEY");
    }
    console.log("Auth successful...");
    const user = await getServiceDeskUserAccount(form_submission_data, secret);
    await addUserToServiceDeskProject(formData, user, secret);
    console.log("User added to Service Desk Project");
    await createServiceDeskRequest(form_submission_data, formData, secret);
    console.log("Service desk ticket created...");
  } catch (e) {
    console.error("Error submitting ticket: ", e);
    throw e;
  }
};

// const verifyCaptcha = async (solution) => {
//   const secretKey = process.env.PUBLIC_FRIENDLY_CAPTCHA_API_KEY;
//   const siteKey = process.env.PUBLIC_FRIENDLY_CAPTCHA_SITEKEY;

//   console.log("Verifying FriendlyCaptcha solution...");

//   const response = await fetch(
//     "https://api.friendlycaptcha.com/api/v1/siteverify",
//     {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({
//         solution: solution,
//         secret: secretKey,
//         sitekey: siteKey,
//       }),
//     }
//   );

//   const data = await response.json();
//   if (!data.success) {
//     console.error("Captcha verification failed:", data.errors);
//   }
//   return data.success;
// };

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
  },
  body: JSON.stringify(body),
});

module.exports.submit = async (event) => {
  try {
    if (!event.body) {
      return response(400, { message: "Missing request body" });
    }

    const form_submission_data = JSON.parse(event.body);

    // 1. (Optional) CAPTCHA — re-enable later
    // ----------------------------------------
    // const captchaSolution = form_submission_data["frc-captcha-solution"];
    // if (!captchaSolution) {
    //   return response(400, { message: "Captcha solution is missing" });
    // }
    //
    // const isHuman = await verifyCaptcha(captchaSolution);
    // if (!isHuman) {
    //   return response(403, { message: "Captcha verification failed" });
    // }

    // 2. FORM LOOKUP
    const formData = fetchFormData(form_submission_data.form_id);
    if (!formData) {
      return response(400, { message: "Unknown form_id" });
    }

    // 3. FORM VALIDATION
    if (!validateForm(formData, form_submission_data)) {
      return response(400, { message: "Invalid form submission" });
    }

    // 4. BUSINESS LOGIC
    await submitTicket(form_submission_data);

    // 5. EMAIL
    try {
      await sendConfirmationEmail(
        form_submission_data,
        "confirmation_dev",
        form_submission_data.email
      );
    } catch (e) {
      console.warn("Confirmation email failed after ticket creation", e);
    }

    // 6. SUCCESS
    return response(200, {
      message: `Successfully submitted form with email ${form_submission_data.email}`,
      formId: form_submission_data.form_id,
    });
  } catch (error) {
    console.error("Error during submission:", error);

    return response(500, {
      message: "An error occurred while processing the submission",
    });
  }
};
