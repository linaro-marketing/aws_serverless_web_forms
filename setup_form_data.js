#!/usr/bin/env node
// This script reads the requests.json config file
// and makes a few requests to the Atlassian Service Desk API
// to retrieve the projectId and requestTypeId
// It will also validate the request fields against the API
const fs = require("fs");
const fetch = global.fetch;
const argv = require("yargs/yargs")(process.argv.slice(2)).argv;

const serviceDeskDomain = "linaro-servicedesk.atlassian.net"; // "servicedesk.linaro.org";

const email = process.env.SERVICE_DESK_USERNAME;
const apiKey = process.env.SERVICE_DESK_API_KEY;

if (!email || !apiKey) {
  console.error(
    "Missing credentials: SERVICE_DESK_USERNAME or SERVICE_DESK_API_KEY."
  );
  process.exit(1);
}

const requestHeaders = {
  method: "GET",
  headers: {
    Authorization:
      "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64"),
    "Content-Type": "application/json",
    Accept: "application/json",
  },
};

const api = async (path) => {
  const url = `https://${serviceDeskDomain}${path}`;
  const res = await fetch(url, requestHeaders);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}: ${text}`);
  }
  return res.json();
};

async function getFormData(formEntry, index) {
  const { projectName, requestType } = formEntry;

  const projects = await api(`/rest/servicedeskapi/servicedesk`);
  const match = projects.values.find((p) => p.projectName === projectName);

  if (!match) throw new Error(`Project not found: ${projectName}`);

  const requestTypes = await api(
    `/rest/servicedeskapi/servicedesk/${match.id}/requesttype`
  );

  console.log("Request Types: ", requestTypes);
  const typeMatch = requestTypes.values.find((t) => t.name === requestType);

  if (!typeMatch) throw new Error(`Request type not found: ${requestType}`);

  const fields = await api(
    `/rest/servicedeskapi/servicedesk/${match.id}/requesttype/${typeMatch.id}/field`
  );

  return {
    form_id: index + 1,
    projectName,
    requestTypeName: requestType,
    projectId: match.id,
    requestTypeId: typeMatch.id,
    fields,
  };
}

function createExampleFormHTML(form) {
  let html = `<form method="POST" action="">\n`;

  form.fields.requestTypeFields.forEach((field) => {
    const { fieldId, name, jiraSchema, validValues } = field;

    if (jiraSchema.type === "string") {
      html += `<input type="text" name="${fieldId}" placeholder="${name}"/>\n`;
    }

    if (jiraSchema.type === "array") {
      validValues.forEach((val, i) => {
        html += `<input type="checkbox" name="${fieldId}" id="${fieldId}-${i}" value="${val.value}"/>\n`;
        html += `<label for="${fieldId}-${i}">${val.label}</label>\n`;
      });
    }
  });

  html += `<input type="submit" value="Submit">\n</form>`;

  fs.writeFileSync(
    `html_examples/example_form-${form.form_id}.html`,
    html,
    "utf8"
  );
}

async function main() {
  if (!argv.path || !argv.outPath) {
    console.error(
      "Usage: node setup_form_data.js --path <config.json> --outPath <output.json>"
    );
    process.exit(1);
  }

  console.log(`📄 Reading config from: ${argv.path}`);

  const config = JSON.parse(fs.readFileSync(argv.path, "utf8"));

  const results = [];
  for (const [index, form] of config.entries()) {
    console.log(`📌 Fetching: ${form.projectName} / ${form.requestType}`);
    results.push(await getFormData(form, index));
  }

  fs.writeFileSync(argv.outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`✅ Form data written to: ${argv.outPath}`);

  console.log(`🧱 Generating HTML examples...`);
  results.forEach(createExampleFormHTML);
  console.log(`✨ Done`);
}

main().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
