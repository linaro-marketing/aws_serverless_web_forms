#!/usr/bin/env node
// This script reads the requests.json config file
// and makes a few requests to the Atlassian Service Desk API
// to retrieve the projectId and requestTypeId
// It will also validate the request fields against the API
const fs = require("fs");
const fetch = require("node-fetch");
const prompt = require("prompt");
const service_desk_domain = "servicedesk.linaro.org";
// Get the args
var argv = require("yargs/yargs")(process.argv.slice(2)).argv;
var requestHeaders = {};
console.log(
  "Please enter your Atlassian Service Desk credentials in order to collect ticket data..."
);
prompt.start();
prompt.get(
  [
    {
      name: "email",
    },
    {
      name: "password",
      hidden: true,
    },
  ],
  async (err, result) => {
    if (err) {
      return onErr(err);
    }
    await main(result);
  }
);
function onErr(err) {
  console.log(err);
  return 1;
}
const getData = (formEntry, index) => {
  var newData = {};
  return fetch(
    `https://${service_desk_domain}/rest/servicedeskapi/servicedesk`,
    requestHeaders
  )
    .then((response) => response.json())
    .then((res) => {
      let projects = res["values"];
      var projectId = "";
      for (let i = 0; i < projects.length; i++) {
        if (projects[i].projectName === formEntry.projectName) {
          projectId = projects[i].id;
        }
      }
      return projectId;
    })
    .then((projectId) => {
      return fetch(
        `https://${service_desk_domain}/rest/servicedeskapi/servicedesk/${projectId}/requesttype`,
        requestHeaders
      );
    })
    .then((response) => response.json())
    .then((res) => {
      let requestTypes = res["values"];
      var requestTypeId = "";
      var projectId = "";
      for (let i = 0; i < requestTypes.length; i++) {
        if (requestTypes[i].name === formEntry.requestType) {
          requestTypeId = requestTypes[i].id;
          projectId = requestTypes[i].serviceDeskId;
        }
      }
      newData = {
        form_id: index + 1,
        projectName: formEntry.projectName,
        requestTypeName: formEntry.requestType,
        projectId: projectId,
        requestTypeId: requestTypeId,
      };
      return newData;
    })
    .then((newData) => {
      return fetch(
        `https://${service_desk_domain}/rest/servicedeskapi/servicedesk/${newData.projectId}/requesttype/${newData.requestTypeId}/field`,
        requestHeaders
      );
    })
    .then((response) => response.json())
    .then((res) => {
      newData.fields = res;
      return newData;
    })
    .catch((err) => {
      console.log("Please make sure your login credentials are correct!");
      console.log(err);
      return false;
    });
};
// Helper function to create an example HTML form for use in your static website
const createExampleFormHTML = (form) => {
  let newForm = `<form method="POST" action="">\n`;
  form.fields.requestTypeFields.forEach((field, index) => {
    if (field.jiraSchema.type === "string") {
      newForm += `<input type="text" name="${field.fieldId}" placeholder="${field.name}"/>\n`;
    } else if (field.jiraSchema.type === "array") {
      field.validValues.forEach((checkboxField, i) => {
        newForm += `<input type="checkbox" name="${field.fieldId}" id="${field.fieldId}-${i}" value="${checkboxField.value}"/>\n`;
        newForm += `<label for="${field.fieldId}-${i}">${checkboxField.label}</label>\n`;
      });
    }
  });
  newForm += `<input type="submit" value="Submit">\n`;
  newForm += `</form>`;
  fs.writeFile(
    `html_examples/example_form-${form.form_id}.html`,
    newForm,
    "utf8",
    (err) => {
      if (err) throw err;
      console.log(
        `example_form-${form.form_id}.html example form has been written!`
      );
    }
  );
  return true;
};
const main = async (result) => {
  requestHeaders = {
    method: "GET",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${result.email}:${result.password}`).toString("base64"),
    },
  };
  console.log(requestHeaders);
  // Check for path arg
  if (argv.path) {
    console.log(`Reading config file - ${argv.path}...`);
    // Read the requests.json config file
    fs.readFile(argv.path, "utf8", async (err, data) => {
      if (err) throw err;
      const obj = JSON.parse(data);
      var promiseArray = [];
      // Loop over form configs
      obj.forEach((formEntry, index) => {
        console.log(
          `Collecting data for ${formEntry.projectName} - ${formEntry.requestType}...`
        );
        const formEntryDataPromise = getData(formEntry, index);
        promiseArray.push(formEntryDataPromise);
      });
      var collectedData = await Promise.all(promiseArray);
      console.log(`Data has been collected!`);
      console.log(`Writing ${argv.outPath} file...`);
      fs.writeFile(
        argv.outPath,
        JSON.stringify(collectedData),
        "utf8",
        (err) => {
          if (err) throw err;
          console.log(`${argv.outPath} has been written!`);
        }
      );
      // Create some example form HTML data.
      console.log("Creating example HTML forms...");
      collectedData.forEach((form, index) => {
        createExampleFormHTML(form);
      });
    });
  } else {
    console.log("");
  }
};
