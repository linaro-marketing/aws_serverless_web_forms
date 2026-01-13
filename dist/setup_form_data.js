#!/usr/bin/env node
import fs from "node:fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
/**
 * Config / env
 */
const serviceDeskDomain = "linaro-servicedesk.atlassian.net";
const email = process.env.SERVICE_DESK_USERNAME;
const apiKey = process.env.SERVICE_DESK_API_KEY;
if (!email || !apiKey) {
    console.error("Missing credentials: SERVICE_DESK_USERNAME or SERVICE_DESK_API_KEY.");
    process.exit(1);
}
const argv = yargs(hideBin(process.argv)).options({
    path: { type: "string", demandOption: true },
    outPath: { type: "string", demandOption: true },
}).argv;
/**
 * HTTP helpers
 */
const requestHeaders = {
    method: "GET",
    headers: {
        Authorization: "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64"),
        "Content-Type": "application/json",
        Accept: "application/json",
    },
};
async function api(path) {
    const url = `https://${serviceDeskDomain}${path}`;
    const res = await fetch(url, requestHeaders);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} for ${url}: ${text}`);
    }
    return res.json();
}
/**
 * Core logic
 */
async function getFormData(formEntry, index) {
    const { projectName, requestType } = formEntry;
    const projects = await api("/rest/servicedeskapi/servicedesk");
    const match = projects.values.find((p) => p.projectName === projectName);
    if (!match) {
        throw new Error(`Project not found: ${projectName}`);
    }
    const requestTypes = await api(`/rest/servicedeskapi/servicedesk/${match.id}/requesttype`);
    const typeMatch = requestTypes.values.find((t) => t.name === requestType);
    if (!typeMatch) {
        throw new Error(`Request type not found: ${requestType}`);
    }
    const fields = await api(`/rest/servicedeskapi/servicedesk/${match.id}/requesttype/${typeMatch.id}/field`);
    return {
        form_id: index + 1,
        projectName,
        requestTypeName: requestType,
        projectId: match.id,
        requestTypeId: typeMatch.id,
        fields,
    };
}
/**
 * HTML generation
 */
function createExampleFormHTML(form) {
    let html = `<form method="POST" action="">\n`;
    form.fields.requestTypeFields.forEach((field) => {
        const { fieldId, name, jiraSchema, validValues } = field;
        if (jiraSchema.type === "string") {
            html += `<input type="text" name="${fieldId}" placeholder="${name}"/>\n`;
        }
        if (jiraSchema.type === "array" && validValues) {
            validValues.forEach((val, i) => {
                html += `<input type="checkbox" name="${fieldId}" id="${fieldId}-${i}" value="${val.value}"/>\n`;
                html += `<label for="${fieldId}-${i}">${val.label}</label>\n`;
            });
        }
    });
    html += `<input type="submit" value="Submit">\n</form>`;
    fs.writeFileSync(`html_examples/example_form-${form.form_id}.html`, html, "utf8");
}
/**
 * Entrypoint
 */
async function main() {
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
    if (!fs.existsSync("html_examples")) {
        fs.mkdirSync("html_examples", { recursive: true });
    }
    results.forEach(createExampleFormHTML);
    console.log(`✨ Done`);
}
try {
    await main();
}
catch (err) {
    if (err instanceof Error) {
        console.error("❌ Fatal error:", err.message);
    }
    else {
        console.error("❌ Fatal error:", err);
    }
    process.exit(1);
}
