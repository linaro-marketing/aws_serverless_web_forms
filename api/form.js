"use strict";

module.exports.submit = (event, context, callback) => {
  const response = {
    statusCode: 200,
    body: JSON.stringify({
      message:
        "Your form has been submitted. Please click the link in your email to confirm and send.",
      input: event,
    }),
  };

  callback(null, response);
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
