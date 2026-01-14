import { Resource } from "sst";
import AWS from "aws-sdk";
import bluebird from "bluebird";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import formDataJson from "./form_data.json";

AWS.config.setPromisesDependency(bluebird);

const ses = new AWS.SES({
  region: "us-east-1",
});

/**
 * Types
 */

type FormSubmissionData = Record<string, any> & {
  form_id: string | number;
  email: string;
  "frc-captcha-response": string;
};

type PurgedFormData = Record<string, any> & {
  form_id?: string | number;
  email?: string;
  "frc-captcha-response"?: string;
};

interface FormField {
  fieldId: string;
  required: boolean;
}

interface FormData {
  form_id: string | number;
  projectId: string;
  requestTypeId: string;
  fields: {
    requestTypeFields: FormField[];
  };
}

interface ServiceDeskUser {
  accountId: string;
  emailAddress?: string;
  displayName?: string;
}

/**
 * Static form data
 */

const formData: FormData[] = formDataJson;

/**
 * Email
 */

const sendConfirmationEmail = async (
  inputs: FormSubmissionData,
  templateName: string,
  sendTo: string
): Promise<void> => {
  const templateData = {
    name: inputs["customfield_13155"],
    description: inputs["description"] ?? inputs["customfield_13365"],
  };

  const params: AWS.SES.SendTemplatedEmailRequest = {
    Template: templateName,
    Destination: { ToAddresses: [sendTo] },
    Source: Resource.VERIFICATION_FROM_EMAIL_ADDR.value,
    TemplateData: JSON.stringify(templateData),
  };

  await ses.sendTemplatedEmail(params).promise();
};

/**
 * Validation
 */

const validateForm = (
  formData: FormData,
  submission: FormSubmissionData
): boolean => {
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

/**
 * Atlassian API
 */

const atlassianRequest = async <T = any>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  password: string,
  payload: unknown = null,
  experimental = false
): Promise<T | null> => {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(
      `${Resource.SERVICE_DESK_USERNAME.value}:${password}`
    ).toString("base64")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Linaro-WebForms-Lambda/2.0",
  };

  if (experimental) {
    headers["X-ExperimentalApi"] = "true";
  }

  const res = await fetch(
    `https://${Resource.SERVICE_DESK_DOMAIN.value}${endpoint}`,
    {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    }
  );

  const contentType = res.headers.get("content-type") ?? "";
  const rawBody = await res.text();

  if (!res.ok) {
    throw new Error(
      `Atlassian API error ${res.status} ${method} ${endpoint}\n${rawBody.slice(
        0,
        500
      )}`
    );
  }

  if (res.status === 204) {
    return null;
  }

  if (!contentType.includes("application/json")) {
    throw new Error(
      `Expected JSON but got ${contentType}\n${rawBody.slice(0, 500)}`
    );
  }

  return JSON.parse(rawBody) as T;
};

/**
 * Service Desk helpers
 */

const getServiceDeskUserAccount = async (
  formSubmissionData: FormSubmissionData,
  secret: string
): Promise<ServiceDeskUser> => {
  const result = await atlassianRequest<ServiceDeskUser[]>(
    `/rest/api/3/user/search?query=${formSubmissionData.email}`,
    "GET",
    secret
  );

  if (!result || result.length === 0) {
    return (await atlassianRequest<ServiceDeskUser>(
      `/rest/servicedeskapi/customer`,
      "POST",
      secret,
      {
        email: formSubmissionData.email,
        displayName: formSubmissionData.email,
      },
      true
    )) as ServiceDeskUser;
  }

  return result[0];
};

const addUserToServiceDeskProject = async (
  formData: FormData,
  user: ServiceDeskUser,
  secret: string
): Promise<void> => {
  await atlassianRequest(
    `/rest/servicedeskapi/servicedesk/${formData.projectId}/customer`,
    "POST",
    secret,
    { accountIds: [user.accountId] },
    true
  );
};

const createServiceDeskRequest = async (
  formSubmissionData: FormSubmissionData,
  formData: FormData,
  secret: string
): Promise<void> => {
  const preparedSubmissionData: PurgedFormData = { ...formSubmissionData };

  const requestEmail = preparedSubmissionData.email;
  delete preparedSubmissionData.email;
  delete preparedSubmissionData.form_id;
  delete preparedSubmissionData["frc-captcha-response"];

  const payload = {
    serviceDeskId: formData.projectId,
    requestTypeId: formData.requestTypeId,
    requestFieldValues: preparedSubmissionData,
    raiseOnBehalfOf: requestEmail,
  };

  await atlassianRequest(
    `/rest/servicedeskapi/request`,
    "POST",
    secret,
    payload
  );
};

/**
 * Form lookup
 */

const fetchFormData = (formId: string | number): FormData | null => {
  const id = formId.toString();
  return formData.find((f: any) => f.form_id.toString() === id) ?? null;
};

/**
 * Ticket submission
 */

const submitTicket = async (
  formSubmissionData: FormSubmissionData
): Promise<void> => {
  const formData = fetchFormData(formSubmissionData.form_id);
  if (!formData) {
    throw new Error(`Unknown form_id ${formSubmissionData.form_id}`);
  }

  const secret = Resource.SERVICE_DESK_API_KEY.value;
  if (!secret) {
    throw new Error("Missing SERVICE_DESK_API_KEY");
  }

  const user = await getServiceDeskUserAccount(formSubmissionData, secret);
  await addUserToServiceDeskProject(formData, user, secret);
  await createServiceDeskRequest(formSubmissionData, formData, secret);
};

/**
 * CAPTCHA
 */

const verifyCaptcha = async (solution: string): Promise<boolean> => {
  const secretKey = Resource.FRIENDLY_CAPTCHA_API_KEY.value;
  const siteKey = Resource.FRIENDLY_CAPTCHA_SITEKEY.value;

  if (!secretKey || !siteKey) return false;

  const res = await fetch(
    "https://global.frcapi.com/api/v2/captcha/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": secretKey,
      },
      body: JSON.stringify({
        response: solution,
        sitekey: siteKey,
      }),
    }
  );

  if (!res.ok) return false;

  const data: { success?: boolean } = await res.json();
  return Boolean(data?.success);
};

/**
 * HTTP response
 */

const response = (
  statusCode: number,
  body: unknown
): APIGatewayProxyResult => ({
  statusCode,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
  },
  body: JSON.stringify(body),
});

/**
 * Lambda handler
 */

export async function submit(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return response(400, { message: "Missing request body" });
    }

    const formSubmissionData: FormSubmissionData = JSON.parse(event.body);

    const captchaSolution = formSubmissionData["frc-captcha-response"];
    if (!captchaSolution) {
      return response(400, { message: "Captcha solution is missing" });
    }

    const isHuman = await verifyCaptcha(captchaSolution);
    if (!isHuman) {
      return response(403, { message: "Captcha verification failed" });
    }

    const formData = fetchFormData(formSubmissionData.form_id);
    if (!formData) {
      return response(400, { message: "Unknown form_id" });
    }

    if (!validateForm(formData, formSubmissionData)) {
      return response(400, { message: "Invalid form submission" });
    }

    await submitTicket(formSubmissionData);

    try {
      await sendConfirmationEmail(
        formSubmissionData,
        "confirmation_dev",
        formSubmissionData.email
      );
    } catch (e) {
      console.warn("Confirmation email failed", e);
    }

    return response(200, {
      message: `Successfully submitted form with email ${formSubmissionData.email}`,
      formId: formSubmissionData.form_id,
    });
  } catch (error) {
    console.error("Error during submission:", error);
    return response(500, {
      message: "An error occurred while processing the submission",
    });
  }
}
