# AWS Serverless Web Forms Service (SST v3)

## Overview

This project provides a serverless form submission API for static websites.

It exposes an API Gateway (HTTP API) backed by a Lambda function that accepts form submissions, validates them, and performs actions such as:

- Sending confirmation emails via Amazon SES
- Creating Atlassian Service Desk (Jira) tickets
- Integrating Friendly Captcha for bot protection

The infrastructure is managed using SST v3, and secrets are handled securely via SST Secrets (no .env files in production).

## Repository Structure

The Lambda handler used by the API is:
`/src/index.submit`

## Prerequisites

You’ll need:

- AWS account
- Node.js 18+ (Node 20 recommended)
- AWS CLI v2
- SST CLI (installed locally via npm)
- AWS credentials (SSO or access keys)

## AWS Authentication

This project assumes AWS credentials are provided via a profile:

```bash
aws sso login --profile webdev
export AWS_PROFILE=webdev
```

SST will automatically pick this up via:

```
providers: {
  aws: {
    profile: process.env.AWS_PROFILE,
  },
}
```

## Secrets

Secrets are managed using SST Secrets and injected into Lambda as environment variables.

Required Secrets
| Name | Description |
| --------- | ---------- |
| VERIFICATION_FROM_EMAIL_ADDR | SES verified sender email |
| SERVICE_DESK_USERNAME | Jira Service Desk username |
| SERVICE_DESK_API_KEY | Jira API token |
| SERVICE_DESK_DOMAIN | Jira domain (e.g. company.atlassian.net) |
| FRIENDLY_CAPTCHA_API_KEY | Friendly Captcha API key |
| FRIENDLY_CAPTCHA_SITEKEY | Friendly Captcha site key |

## Setting Secrets

Secrets are stage-specific in SST.

```bash
npx sst secret set VERIFICATION_FROM_EMAIL_ADDR support@example.com --stage stagename
npx sst secret set SERVICE_DESK_USERNAME bot@example.com --stage stagename
npx sst secret set SERVICE_DESK_API_KEY <api-token> --stage stagename
npx sst secret set SERVICE_DESK_DOMAIN example.atlassian.net --stage stagename
npx sst secret set FRIENDLY_CAPTCHA_API_KEY <key> --stage stagename
npx sst secret set FRIENDLY_CAPTCHA_SITEKEY <key> --stage stagename
```

## Local Development

Run the app in development mode:

```bash
npm run dev
# or
npx sst dev
```

This will:

- Deploy a dev stage (named after your username by default)
- Create the API Gateway, Lambda, and secrets
- Stream logs live to your terminal

You’ll see output like:

```bash
ApiEndpoint: https://xxxx.execute-api.us-east-1.amazonaws.com
```

## Testing the API

Using curl

```bash
curl -X POST https://<api-endpoint>/formSubmit \
-H "Content-Type: application/json" \
-d '{
"email": "test@example.com",
"name": "Test User",
"message": "Hello world"
}'
```

Expected response:

```json
{
  "success": true,
  "message": "Form submitted"
}
```

From a Frontend App

```js
await fetch("https://<api-endpoint>/formSubmit", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});
```

## Deployment

Deploy a Stage

```bash
npm run deploy --stage mystage

# or

npx sst deploy --stage prod
```

Stages:

- dev / personal stage → auto-removed on destroy
- prod → retained resources

Retention is controlled here:

```
removal: input.stage === "prod" ? "retain" : "remove",
```

## Logging & Debugging

### View Logs

Lambda logs are available in CloudWatch.
You can also stream logs during development via:

```
npx sst dev
```

Errors inside the handler should always be logged:

```
console.error("Error in submit:", err);
```

## SES Notes

The VERIFICATION_FROM_EMAIL_ADDR must be verified in SES

In sandbox mode, recipient emails must also be verified

SES is configured for "us-east-1"

## Notes on Legacy Serverless Framework

This project no longer uses the Serverless Framework (serverless.yml, sls deploy, .env files, etc.).
All infrastructure is now defined in:

```
sst.config.ts
```

Secrets, stages, and deployments are handled entirely by SST.
