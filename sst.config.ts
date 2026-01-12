/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "aws-web-forms",
      home: "aws",
      removal: input.stage === "prod" ? "retain" : "remove",
      providers: {
        aws: {
          profile: process.env.AWS_PROFILE,
        },
      },
    };
  },

  async run() {
    const fs = await import("fs");
    const path = await import("path");

    // 1. Secrets
    const fromEmail = new sst.Secret("VERIFICATION_FROM_EMAIL_ADDR");
    const sdUsername = new sst.Secret("SERVICE_DESK_USERNAME");
    const sdApiKey = new sst.Secret("SERVICE_DESK_API_KEY");
    const sdDomain = new sst.Secret("SERVICE_DESK_DOMAIN");
    const fcApiKey = new sst.Secret("FRIENDLY_CAPTCHA_API_KEY");
    const fcSiteKey = new sst.Secret("FRIENDLY_CAPTCHA_SITEKEY");

    // 2. Email Set Up
    const confirmationTemplate = new aws.ses.Template("ConfirmationTemplate", {
      name: "confirmation",
      subject: "Linaro - Confirm your website form submission",
      html: fs.readFileSync("templates/confirmation.html", "utf8"),
      text: fs.readFileSync("templates/confirmation.txt", "utf8"),
    });

    // 3. Lambda
    const formFn = new sst.aws.Function("FormHandler", {
      handler: "src/index.submit",
      runtime: "nodejs20.x",
      timeout: "30 seconds",
      memory: "128 MB",
      permissions: [
        {
          actions: [
            "ses:SendEmail",
            "ses:SendTemplatedEmail",
            "sts:AssumeRole",
            "sns:Publish",
          ],
          resources: ["*"],
        },
      ],
      link: [
        fromEmail,
        sdUsername,
        sdApiKey,
        sdDomain,
        fcApiKey,
        fcSiteKey,
        confirmationTemplate,
      ],
    });

    // 4. API
    const api = new sst.aws.ApiGatewayV2("FormsApi", {
      cors: {
        allowOrigins: ["*"],
        allowHeaders: ["Content-Type", "X-Api-Key"],
      },
    });

    api.route("POST /formSubmit", formFn.arn);

    // 5. Outputs
    return {
      ApiEndpoint: api.url,
    };
  },
});
