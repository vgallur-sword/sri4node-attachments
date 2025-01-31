/* eslint-env node, mocha */
const expressFactory = require("express");
const sri4node = require("sri4node");
const sleep = require('await-sleep');

const sri4nodeConfigFactory = require("./context/config");

const testPartyAttachmentsCheckStoreAttachmentMod =  require("./testPartyAttachmentsCheckStoreAttachment");

const port = 5000;
const base = `http://localhost:${port}`;

const httpClientMod = require("./httpClient.js");
const httpClient = httpClientMod.httpClientFactory(base);

const { info, error } = require("../js/common");

let serverStarted = false;

/**
 * 
 * @param {string} id 
 * @param {boolean} handleMultipleUploadsTogether 
 * @param {boolean} uploadInSequence 
 * @param {*} customStoreAttachment 
 * @returns 
 */
const initServer = async (id, handleMultipleUploadsTogether, uploadInSequence, customStoreAttachment) => {
  try {
    const app = expressFactory();
    if (serverStarted) {
      // It seems that Express has no method to deinitialize or to clear routes.
      // Workaround: let the 'app' variable go out of scope and wait 5 seconds, this
      // seems to deinitialize Express. If Express is just reinitiated with its new
      // configuration without some waiting before usage, Express keeps using the old
      // routes (probably somehow cached).
      await sleep(5000);
    }

    const sriConfig = await sri4nodeConfigFactory(handleMultipleUploadsTogether, uploadInSequence, customStoreAttachment);
    sriConfig.description = `config of sri4node-attachments(${id})`;
    const sri4nodeServerInstance = await sri4node.configure(app, sriConfig);
    app.set("port", port);
    const server = app.listen(port, () => {
      info(`Node app is running at localhost:${port}`);
    });
    serverStarted = true;
    return { sri4nodeServerInstance, server };
  } catch (err) {
    error("Unable to start server.");
    error(err);
    error(err.stack);
    process.exit(1);
  }
};

const closeServer = async (server, sri4nodeServerInstance) => {
  try {
    await server.close();
  } catch (err) {
    console.log("Closing express server failed");
  }
  try {
    await sri4nodeServerInstance.pgp.end();
  } catch (err) {
    console.log("Closing sri4nodeServerInstance failed");
  }
};

const runTests = async (httpClient, checkStoreAttachmentsReceivedList) => {
  require("./testPartyAttachments")(httpClient, "/partiesS3");

  testPartyAttachmentsCheckStoreAttachmentMod.factory(httpClient, "/partiesS3", checkStoreAttachmentsReceivedList);

  // local storage is currenlty not supported anymore
  // require("./testPartyAttachments")(base, "/partiesFolder");
};


describe("Unit tests : ", () => {
  require("./unitTests");
});

// To be able to test the attachments plugin with different configuration parameters we need to start
// different server instances:
//                                    handleMultipleUploadsTogether  uploadInSequence
//   sri4node-attachments(1) :                  false                       n/a
//   sri4node-attachments(2) :                  true                        true
//   sri4node-attachments(3) :                  true                        false


describe("sri4node-attachments(1) : ", () => {
  /** @type {import("sri4node").TSriServerInstance} */
  let sri4nodeServerInstance;
  let server;
  const checkStoreAttachmentsReceivedList = [];

  before(async () => {
    const handleMultipleUploadsTogether = false;
    const uploadInSequence = false; // uploadInSequence value does not matter in case of handleMultipleUploadsTogether=false
                                    // (not relevant and thus not used in that code path)
    const customStoreAttachment = testPartyAttachmentsCheckStoreAttachmentMod.checkStoreAttachmentFactory(handleMultipleUploadsTogether, uploadInSequence, checkStoreAttachmentsReceivedList);
    ({ sri4nodeServerInstance, server } = await initServer('1', handleMultipleUploadsTogether, uploadInSequence, customStoreAttachment));
  });

  after(async () => {
    // enable this to keep the server running for inspection
    // await new Promise(() => {});
    await closeServer(server, sri4nodeServerInstance);
  });

  runTests(httpClient, checkStoreAttachmentsReceivedList);
});


// Configuration with multiple uploads together
describe("sri4node-attachments(2) : ", () => {
  /** @type {import("sri4node").TSriServerInstance} */
  let sri4nodeServerInstance;
  let server;

  before(async () => {
    const handleMultipleUploadsTogether = true;
    const uploadInSequence = true;
    const customStoreAttachment = testPartyAttachmentsCheckStoreAttachmentMod.checkStoreAttachmentFactory(handleMultipleUploadsTogether, uploadInSequence);
    ({ sri4nodeServerInstance, server } = await initServer('2', handleMultipleUploadsTogether, uploadInSequence, customStoreAttachment));
  });

  after(async () => {
    // enable this to keep the server running for inspection
    // await new Promise(() => {});
    await closeServer(server, sri4nodeServerInstance);
  });

  runTests(httpClient);
});

// Configuration with multiple uploads together
describe("sri4node-attachments(3) : ", () => {
  /** @type {import("sri4node").TSriServerInstance} */
  let sri4nodeServerInstance;
  let server;

  before(async () => {
    const handleMultipleUploadsTogether = true;
    const uploadInSequence = false;
    const customStoreAttachment = testPartyAttachmentsCheckStoreAttachmentMod.checkStoreAttachmentFactory(handleMultipleUploadsTogether, uploadInSequence);
    ({ sri4nodeServerInstance, server } = await initServer('3', handleMultipleUploadsTogether, uploadInSequence, customStoreAttachment));
  });

  after(async () => {
    // enable this to keep the server running for inspection
    // await new Promise(() => {});
    await closeServer(server, sri4nodeServerInstance);
  });

  runTests(httpClient);
});
