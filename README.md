# AWS Serverless Web Forms Service

## Overview

This Serverless project creates an email-verified HTML form submission API. Our static websites require lead-collection forms that should create Altassian Service Desk tickets. This project will create a staged API Gateway REST API that executes a Lambda function. The Lambda function then stores the form entry details in DynamoDB, temporarily, whilst a confirmation email is sent to form submitter. Upon clicking the verfification link, the form details are retrieved from DynamoDB and subsequently a Service Desk ticket is created.

## Getting Started

To get started with this project you'll need:

- A static website
- AWS Account
- Latest version of Serverless Framework CLI installed (`npm install -g serverless`)
- NodeJS
- a `.env` file with values for:

```
SERVICE_DESK_DOMAIN=
VERIFICATION_FROM_EMAIL_ADDR=
SERVICE_DESK_USERNAME=
```

### Pre-processing (if using Atlassian Service Desk)

The `config/formConfig.json` file stores the Jira Service Desk custom request configuration.

You should supply an array of objects containing `projectName` and `requestType` attributes.

```json
[
  {
    "projectName": "Linaro Contact",
    "requestType": "Developer Services Request"
  }
]
```

You'll also need to make sure the API domain is correct in `setup_form_data.js`. Once setup, you can then run `sls collectFormData`. You will be prompted for an email address (use the support bot one) and a password (use the API token).

This will execute `setup_form_data.js` and require your Service Desk login credentials to access the REST API for Service Desk (i.e. email address and API token). This script will then output `form_data.json` and some example HTML forms in `html_examples/`. `form_data.json` is used by the lambda function to verify and match incoming requests.

### Deploying

To deploy the staging environment stack run `aws2-wrap --profile <YOUR_AWS_PROFILE> --exec "sls deploy --verbose --stage dev"`.

To deploy the production environment stack run `aws2-wrap --profile <YOUR_AWS_PROFILE> --exec "sls deploy --verbose --stage prod"`.

#### IAM Permissions

You may need to make sure your account has the correct permissions to deploy the neccessary resources. I've generated some base IAM policies with `yeoman`/`serverless-policy` (examples of these are in `config/`).

## SES Templates

The stored SES templates can be checked with:

```
aws ses list-templates
```

There will be one set for production and one set for development.

Each template can be retrieved with `aws ses get-template --template-name <name> > <name>.json` and then updated on SES with `aws ses update-template --cli-input-json file://<name>.json`.

This repository holds the HTML and plain text templates, with the HTML being minified as well. The latter needs to go through a search/replace, so that `"` is replaced with `\"` before inserting into the SES template.
