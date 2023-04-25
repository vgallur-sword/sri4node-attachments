const assert = require("assert");

const needle = require("needle");
const uuid = require("uuid");
const { debug } = require("../js/common.js");
const fs = require("fs");

/**
 * @typedef { {
 *  remotefileName: string,
 *  localFilename: string,
 *  attachmentKey: string,
 *  resourceHref: string
 * } } TFileToUpload
 * @typedef { {
 *  remotefileName: string,
 *  urlToCopy: string,
 *  attachmentKey: string,
 *  resourceHref: string
 * } } TFileToCopy
 */

/**
 *
 * @param {import('needle').NeedleHttpVerbs} method
 * @param {string} url
 * @param {any} body will be JSON.stringified first !!!
 * @returns
 */
const doHttp = (method, url, body) =>
  needle(method, url, body, {
    json: true,
  });

const doGetStream = (url) =>
  needle.get(url, {
    json: true,
  });
const doGet = (url) => doHttp("get", url, "");
const doDelete = (url) => doHttp("delete", url, "");
const doPut = (url, body) => doHttp("put", url, body);

const deleteAttachmentAndVerify = async (
  attachmentUrl,
  attachmentDownloadUrl
) => {
  // Delete the attachment
  const responseDelete = await doDelete(attachmentUrl);
  assert.equal(responseDelete.statusCode, 204);

  // verify if attachment is gone
  const responseGetAtt2 = await doGet(attachmentUrl);
  assert.equal(responseGetAtt2.statusCode, 404);
  const responseGetAtt3 = await doGet(attachmentDownloadUrl);
  assert.equal(responseGetAtt3.statusCode, 404);
};

/**
 * This will use the /resource/attachments endpoint to upload one or multiple files.
 * This is a multipart post, where the 'body' part is a stringified and properly escaped
 * (escaping is handled by needle) JSON array of objects, each object having the following
 * properties:
 * ```javascript
 * {
 *    file: 'remotefileName', // string
 *    attachment: {
 *      key: attachmentKey, // guid
 *      description: `this is MY file`, // string
 *    },
 *    resource: {
 *      href: resourceHref, // href to the resource to which this attachment is attached
 *    },
 * }
 * ```
 * The 'data' part is a file, which is the local file to be uploaded.
 *
 * This translates to something like this:
 * ```
 * POST /partiesS3/attachments HTTP/1.1
 * content-type: multipart/form-data; boundary=--------------------NODENEEDLEHTTPCLIENT
 * content-length: 10977
 * host: localhost:5000
 * Connection: close
 *
 * ----------------------NODENEEDLEHTTPCLIENT
 * Content-Disposition: form-data; name="body"
 *
 * [{"file":"profile.png","attachment":{"key":"18f6f8ea-3926-4fe7-80a0-49cec88a66fd","description":"this is MY file with key 18f6f8ea-3926-4fe7-80a0-49cec88a66fd"},"resource":{"href":"/partiesS3/2691d53a-6f24-416e-9621-3cd14c05c5a6"}}]
 * ----------------------NODENEEDLEHTTPCLIENT
 * Content-Disposition: form-data; name="data"; filename="profile.png"
 * Content-Transfer-Encoding: binary
 * Content-Type: image/png
 *
 * <binary data>
 * ----------------------NODENEEDLEHTTPCLIENT--
 * ```
 *
 * An alternative form could be using additional headers to indicate file properties instead of the JSON 'body':
 *
 * ```js
 *   const form = new FormData();
 *   form.append(`1_${localFilename}`, fs.createReadStream(localFilename), { header: { hello: 'goodbye' } });
 *   form.append(`2_${localFilename}`, fs.createReadStream(localFilename));
 *   form.append(`3_${localFilename}`, fs.createReadStream(localFilename));
 * ```
 *
 * Which translates to something like this:
 * ```
 * POST /partiesS3 HTTP/1.1
 * content-type: multipart/form-data; boundary=--------------------------732677279853170760492713
 * Host: localhost:5000
 * Content-Length: 31895
 * Connection: close
 *
 * ----------------------------732677279853170760492713
 * Content-Disposition: form-data; name="1_test/orange-boy-icon.png"; filename="orange-boy-icon.png"
 * Content-Type: image/png
 * hello: goodbye
 *
 * <binary data>
 * ----------------------------732677279853170760492713
 * Content-Disposition: form-data; name="2_test/orange-boy-icon.png"; filename="orange-boy-icon.png"
 * Content-Type: image/png
 *
 * <binary data>
 * ----------------------------732677279853170760492713
 * Content-Disposition: form-data; name="3_test/orange-boy-icon.png"; filename="orange-boy-icon.png"
 * Content-Type: image/png
 *
 * <binary data>
 * ----------------------------732677279853170760492713--
 * ```
 *
 * @param {string} resourceUrl is the url of the resource for which you want to put an attachment
 *                              for example https://localhost:5000/partiesS3/<some-guid>
 * @param {Array<TFileToUpload | TFileToCopy>} fileDetails
 * @returns {Promise<import('needle').NeedleResponse>} a needle http response
 */
async function doPutFiles(resourceUrl, fileDetails) {
  const options = {
    multipart: true,
  };

  // body=[{\"file\":\"thumbsUp.1.png\",\"attachment\":{\"key\":\"19f50272-8438-4662-9386-5fc789420262\",\"description\":\"this is MY file\"}

  const data = Object.fromEntries([
    [
      "body",
      JSON.stringify(
        fileDetails.map(
          ({ remotefileName, attachmentKey, resourceHref, urlToCopy }) => ({
            file: remotefileName,
            fileHref: urlToCopy, // can be undefined, but if it's there, this is the url that should be copied
            // instead of uploading a local file
            attachment: {
              key: attachmentKey,
              description: `this is MY file with key ${attachmentKey}`,
            },
            resource: {
              href: resourceHref,
            },
          })
        )
      ),
    ],
    ...fileDetails
      .filter((f) => f.localFilename !== undefined)
      .map(({ remotefileName, localFilename, attachmentKey }) => [
        attachmentKey,
        {
          // file: localFilename,
          buffer: fs.readFileSync(localFilename),
          content_type: "image/png",
          filename: remotefileName,
        },
      ]),
  ]);

  return needle("post", resourceUrl + "/attachments", data, options);
}

/**
 * Will reaturn a readable stream, which will download the file from the api.
 *
 * @param {*} url
 * @returns {import('needle').ReadableStream}
 */
function getGetStream(url) {
  const getStream = doGetStream(url);

  getStream.on("done", function (err) {
    // if our request had an error, our 'done' event will tell us.
    if (err) {
      console.log(`streaming get request (${url}) failed:`);
      console.log(err);
      throw err;
    }
  });

  return getStream;
}

/**
 * Reads a stream into a buffer.
 *
 * @param {*} stream
 * @returns
 */
async function getStreamAsBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Will throw an assertion error if the two streams are not equal.
 *
 * We'll collect all bytes first because we only expect short files!
 *
 * @param {ReadableStream} s1
 * @param {ReadableStream} s2
 * @throws {AssertionError}
 */
async function checkStreamEqual(s1, s2) {
  const b1 = await getStreamAsBuffer(s1);
  const b2 = await getStreamAsBuffer(s2);
  if (b1.byteLength !== b2.byteLength) {
    assert.fail(
      `Streams are not equal. They have different lengths: ${b1.byteLength} != ${b2.byteLength}`
    );
  }
  let index = 0;
  const it2 = b2[Symbol.iterator]();
  for (const v1 of b1) {
    const { value: v2 } = await it2.next();
    if (v1 !== v2) {
      assert.fail(
        `Streams are not equal. At position ${index} ${v1.toString()} != ${v2.toString()}`
      );
    }
    index++;
  }
}

/**
 * A function which will check if the uploaded files are uploaded correctly,
 * by downloading them again from the api, and by comparing the bytestream with the file
 * on disk.
 * It also supports copyied files from another url.
 *
 * @param {string} baseApiUrl (like https://api.org.com)
 * @param {Array<{ remotefileName, localFilename, attachmentKey, resourceHref}>} filesToPut
 */
async function checkUploadedFiles(baseApiUrl, filesToPut) {
  for (const {
    remotefileName,
    localFilename,
    resourceHref,
    urlToCopy,
  } of filesToPut) {
    const url = baseApiUrl + resourceHref + "/attachments/" + remotefileName;

    const getStream = getGetStream(url);

    if (localFilename) {
      await checkStreamEqual(getStream, fs.createReadStream(localFilename));
    } else if (urlToCopy) {
      await checkStreamEqual(getStream, getGetStream(urlToCopy));
    }
  }
}

/**
 * This will upload all the files in the filesToPut array, and then check if the files are
 * uploaded correctly (by checking status code + comparing the downloaded stream to the file
 * on disk).
 *
 * @param {string} baseUrl like https://api.org.com
 * @param {Array<TFileToUpload | TFileToCopy>} filesToPut
 */
async function uploadFilesAndCheck(baseUrl, filesToPut) {
  if (filesToPut && filesToPut.length > 0) {
    const href = filesToPut[0].resourceHref;
    const basePath = href.substring(0, href.lastIndexOf("/"));
    const putResponse = await doPutFiles(baseUrl + basePath, filesToPut);

    assert.equal(putResponse.statusCode, 200);

    await checkUploadedFiles(baseUrl, filesToPut);
  } else {
    assert.fail("[uploadFilesAndCheck]: filesToPut is empty or not defined.");
  }
}

exports = module.exports = function (base, type) {
  describe(type, function () {
    describe("PUT (customRouteForUpload)", function () {
      // checks customRouteForUpload, customRouteForDownload and customRouteForDelete
      it("should allow adding of profile picture as attachment", async () => {
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey = uuid.v4();

        const responsePut = await doPut(base + resourceHref, body);
        assert.equal(responsePut.statusCode, 201);

        // Add attachment
        debug("PUTting the profile image as attachment");
        const filesToPut = [
          {
            remotefileName: "profile.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut);

        // Overwrite attachment
        const filesToPut2 = [
          {
            remotefileName: "profile.png",
            localFilename: "test/images/little-boy-white.png",
            attachmentKey,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut2);

        const attachmentUrl =
          base + type + "/" + resourceKey + "/attachments/" + attachmentKey;
        const attachmentDownloadUrl =
          base + type + "/" + resourceKey + "/attachments/profile.png";

        // Next : try to delete the resource.
        const response6 = await doDelete(attachmentUrl);
        assert.equal(response6.statusCode, 204);
        // Now check that is is gone..
        const response7 = await doGet(attachmentDownloadUrl);
        assert.equal(response7.statusCode, 404);
      });

      it("should be idempotent", async function () {
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey = uuid.v4();
        const attachmentUrl =
          base + type + "/" + resourceKey + "/attachments/profile.png";

        debug("Generated UUID=" + resourceKey);
        const response = await doPut(base + resourceHref, body);
        assert.equal(response.statusCode, 201);

        debug("PUTting the profile image as attachment");
        const filesToPut = [
          {
            remotefileName: "profile.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey,
            resourceHref,
          },
        ];

        const responsePutAtt = await doPutFiles(base + type, filesToPut);
        assert.equal(responsePutAtt.statusCode, 200);
        const getStream1 = getGetStream(attachmentUrl);

        // same put
        const responsePutAtt2 = await doPutFiles(base + type, filesToPut);
        assert.equal(responsePutAtt2.statusCode, 200);
        const getStream2 = getGetStream(attachmentUrl);

        // compare both streams
        checkStreamEqual(getStream1, getStream2);
      });

      it("add and replace should work", async function () {
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey1 = uuid.v4();
        const attachmentKey2 = uuid.v4();

        const responsePut = await doPut(base + resourceHref, body);
        assert.equal(responsePut.statusCode, 201);

        // Add attachment
        debug("PUTting the profile image as attachment");
        const filesToPut = [
          {
            remotefileName: "profile.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut);

        debug("Adding another profile picture");
        const filesToPut2 = [
          {
            remotefileName: "profile2.png",
            localFilename: "test/images/avatar-black.png",
            attachmentKey: attachmentKey2,
            resourceHref,
          },
        ];

        await uploadFilesAndCheck(base, filesToPut2);

        // Check if we have the two expected attachments
        const responseGet1 = await doGet(base + type + "/" + resourceKey);
        assert.equal(responseGet1.statusCode, 200);
        console.log(responseGet1.body.attachments.length, 2);
        for (const href of responseGet1.body.attachments.map((a) => a.href)) {
          const responseGetA = await doGet(base + href);
          // console.log(base + href)
          // console.log(responseGetA.statusCode)
          assert.equal(responseGetA.statusCode, 200);
        }

        debug("Replacing one of two attachments");
        const filesToPut3 = [
          {
            remotefileName: "profile1.png",
            localFilename: "test/images/avatar-blue.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut3);

        // Check if (only) the two expected attachments are there
        const responseGet2 = await doGet(base + type + "/" + resourceKey);
        assert.equal(responseGet2.statusCode, 200);
        console.log(responseGet2.body.attachments.length, 2);

        const getStream1 = getGetStream(
          base + `/partiesS3/${resourceKey}/attachments/profile1.png`
        );

        checkStreamEqual(
          getStream1,
          fs.createReadStream("test/images/avatar-blue.png")
        );

        const getStream2 = getGetStream(
          base + `/partiesS3/${resourceKey}/attachments/profile2.png`
        );

        checkStreamEqual(
          getStream2,
          fs.createReadStream("test/images/avatar-black.png")
        );

        const responseGet3 = await doGet(
          base + `/partiesS3/${resourceKey}/attachments/profile.png`
        );
        // TODO: this does not work: attachment is not being overwritten by reusing a attachmentKey !
        assert.equal(responseGet3.statusCode, 404);
      });
    });

    describe("PUT MULTIPLE (customRouteForUpload)", function () {
      it("should allow adding of 2 files as attachment in a single POST multipart/form-data operation", async () => {
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey1 = uuid.v4();
        const attachmentKey2 = uuid.v4();
        const attachmentKey3 = uuid.v4();
        const attachmentUrl1 =
          base + type + "/" + resourceKey + "/attachments/" + attachmentKey1;
        const attachmentDownloadUrl1 =
          base + type + "/" + resourceKey + "/attachments/profile1.png";
        const attachmentDownloadUrl2 =
          base + type + "/" + resourceKey + "/attachments/profile2.png";
        const attachmentDownloadUrl3 =
          base + type + "/" + resourceKey + "/attachments/profile3.png";

        const response = await doPut(base + resourceHref, body);
        assert.equal(response.statusCode, 201);

        debug("PUTting the profile images as attachments");
        const filesToPut = [
          {
            remotefileName: "profile1.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
          {
            remotefileName: "profile2.png",
            localFilename: "test/images/little-boy-white.png",
            attachmentKey: attachmentKey2,
            resourceHref,
          },
        ];

        await uploadFilesAndCheck(base, filesToPut);

        // Multiple upload with one extra attachment
        const filesToPut2 = [
          {
            remotefileName: "profile1.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
          {
            remotefileName: "profile2.png",
            localFilename: "test/images/little-boy-white.png",
            attachmentKey: attachmentKey2,
            resourceHref,
          },
          {
            remotefileName: "profile3.png",
            localFilename: "test/images/avatar-black.png",
            attachmentKey: attachmentKey3,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut2);

        // Next : try to delete one resource.
        const response6 = await doDelete(attachmentUrl1);
        assert.equal(response6.statusCode, 204);
        // Now check that one attachment is gone and the others are still available
        const response7 = await doGet(attachmentDownloadUrl1);
        assert.equal(response7.statusCode, 404);
        const response8 = await doGet(attachmentDownloadUrl2);
        assert.equal(response8.statusCode, 200);
        const response9 = await doGet(attachmentDownloadUrl3);
        assert.equal(response9.statusCode, 200);
      });

      it.skip("should also allow copying of existing files as (together with uploading some files) single POST multipart/form-data operation", async () => {
        // TODO: finish this test and make it work
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey1 = uuid.v4();
        const attachmentKey2 = uuid.v4();
        const attachmentKey3 = uuid.v4();
        const attachmentUrl1 =
          base + type + "/" + resourceKey + "/attachments/" + attachmentKey1;
        const attachmentDownloadUrl1 =
          base + type + "/" + resourceKey + "/attachments/profile1.png";
        const attachmentDownloadUrl2 =
          base + type + "/" + resourceKey + "/attachments/profile2.png";
        const attachmentDownloadUrl3 =
          base + type + "/" + resourceKey + "/attachments/profile2.png";

        const response = await doPut(base + resourceHref, body);
        assert.equal(response.statusCode, 201);

        debug("PUTting 1 profile image as attachment");
        const filesToPut = [
          {
            remotefileName: "profile1.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
        ];

        await uploadFilesAndCheck(base, filesToPut);

        // Multiple upload with one extra attachment which is a copy of an existing attachment
        // TODO: this can only work if customRouteForUpload gets a second argument!
        const filesToPut2 = [
          {
            remotefileName: "profile2.png",
            urlToCopy: attachmentDownloadUrl1,
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
          {
            remotefileName: "profile3.png",
            urlToCopy: attachmentDownloadUrl1,
            localFilename: "test/images/little-boy-white.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut2);
      });

      it.skip("should support handleMultipleUploadsTogether", async () => {
        // TODO: implement this test (or remove the feature)
      });
    });

    describe("customRouteForGet", function () {
      it("/resource/:key/attachments/:attachmentKey should work", async () => {
        // this function implicitly tests functions passed to
        // customRouteForUpload, customRouteForUploadCopy, customRouteForDelete and customRouteForGet

        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey = uuid.v4();
        const localFilename = "test/images/orange-boy-icon.png";
        const attachmentUrl = `${base}${type}/${resourceKey}/attachments/${attachmentKey}`;
        const attachmentDownloadUrl =
          base + type + "/" + resourceKey + "/attachments/profile.png";

        const responsePut = await doPut(base + resourceHref, body);
        assert.equal(responsePut.statusCode, 201);

        // Add attachment
        debug("PUTting the profile image as attachment");
        const filesToPut = [
          {
            remotefileName: "profile.png",
            localFilename,
            attachmentKey,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut);

        const responseGetAtt1 = await doGet(
          `${base}${type}/${resourceKey}/attachments/${attachmentKey}`
        );
        assert.equal(responseGetAtt1.statusCode, 200);
        assert.equal(
          responseGetAtt1.body.description,
          `this is MY file with key ${attachmentKey}`
        );

        // Copy resource and attachment
        const resourceCopyKey = uuid.v4();
        const resourceCopyHref = type + "/" + resourceCopyKey;
        const copyResponse = await doPut(base + resourceCopyHref, body);
        assert.equal(copyResponse.statusCode, 201);

        const attachmentCopyKey = uuid.v4();
        const copyAttBody = [
          {
            file: "profile1.png",
            fileHref: attachmentDownloadUrl,
            attachment: {
              key: attachmentCopyKey,
              description: `this is MY file with key ${attachmentKey}`,
            },
            resource: {
              href: resourceCopyHref,
            },
          },
        ];
        const copyAttResult = await needle(
          "post",
          `${base + type}/attachments/copy`,
          copyAttBody,
          { json: true }
        );
        assert.equal(copyAttResult.statusCode, 200);

        const attachmentCopyUrl = `${base}${type}/${resourceCopyKey}/attachments/${attachmentCopyKey}`;
        const attachmentCopyDownloadUrl = `${base}${type}/${resourceCopyKey}/attachments/profile1.png`;

        const responseGetAtt2 = await doGet(attachmentCopyUrl);
        assert.equal(responseGetAtt2.statusCode, 200);
        assert.equal(
          responseGetAtt2.body.description,
          `this is MY file with key ${attachmentKey}`
        ); // copy has description of orig!

        // Delete and verify the copied attachment
        await deleteAttachmentAndVerify(
          attachmentCopyUrl,
          attachmentCopyDownloadUrl
        );

        // Verify if original attachment is still there
        const responseGetAtt3 = await doGet(attachmentUrl);
        assert.equal(responseGetAtt3.statusCode, 200);
        assert.equal(
          responseGetAtt3.body.description,
          `this is MY file with key ${attachmentKey}`
        );

        // Delete and verify the original attachment
        await deleteAttachmentAndVerify(attachmentUrl, attachmentDownloadUrl);
      });
    });

    describe("customRouteForUploadCopy", function () {
      it("copy attachments should work", async () => {
        const body = {
          type: "person",
          name: "test user",
          status: "active",
        };
        const resourceKey = uuid.v4();
        const resourceHref = type + "/" + resourceKey;
        const attachmentKey1 = uuid.v4();
        const attachmentKey2 = uuid.v4();
        const attachmentUrl1 =
          base + type + "/" + resourceKey + "/attachments/profile1.png";
        const attachmentUrl2 =
          base + type + "/" + resourceKey + "/attachments/profile2.png";

        const response = await doPut(base + resourceHref, body);
        assert.equal(response.statusCode, 201);

        debug("PUTting the profile images as attachments");
        const filesToPut = [
          {
            remotefileName: "profile1.png",
            localFilename: "test/images/orange-boy-icon.png",
            attachmentKey: attachmentKey1,
            resourceHref,
          },
          {
            remotefileName: "profile2.png",
            localFilename: "test/images/little-boy-white.png",
            attachmentKey: attachmentKey2,
            resourceHref,
          },
        ];
        await uploadFilesAndCheck(base, filesToPut);

        // Copy the resource
        const resourceCopyKey = uuid.v4();
        const resourceCopyHref = type + "/" + resourceCopyKey;
        const copyResponse = await doPut(base + resourceCopyHref, body);
        assert.equal(copyResponse.statusCode, 201);

        // Copy the attachments
        const attachmentCopyKey1 = uuid.v4();
        const attachmentCopyKey2 = uuid.v4();

        const copyAttBody = [
          {
            file: "profile1.png",
            fileHref: attachmentUrl1,
            attachment: {
              key: attachmentCopyKey1,
              description: `this is MY file with key ${attachmentKey1}`,
            },
            resource: {
              href: resourceCopyHref,
            },
          },
          {
            file: "profile2.png",
            fileHref: attachmentUrl2,
            attachment: {
              key: attachmentCopyKey2,
              description: `this is MY file with key ${attachmentKey1}`,
            },
            resource: {
              href: resourceCopyHref,
            },
          },
        ];
        const copyAttResult = await needle(
          "post",
          `${base + type}/attachments/copy`,
          copyAttBody,
          { json: true }
        );
        assert.equal(copyAttResult.statusCode, 200);

        // verify if the copied attachments are present
        const attachmentCopyUrl1 =
          base + type + "/" + resourceCopyKey + "/attachments/profile1.png";
        const attachmentCopyUrl2 =
          base + type + "/" + resourceCopyKey + "/attachments/profile2.png";

        const responseGetCopyAtt1 = await doGet(attachmentCopyUrl1);
        assert.equal(responseGetCopyAtt1.statusCode, 200);

        const responseGetCopyAtt2 = await doGet(attachmentCopyUrl2);
        assert.equal(responseGetCopyAtt2.statusCode, 200);
      });

      it("copy attachments without fileHref should result in proper error", async () => {
        const attachmentKey1 = uuid.v4();
        const resourceCopyKey = uuid.v4();
        const resourceCopyHref = type + "/" + resourceCopyKey;
        const attachmentCopyKey1 = uuid.v4();

        const copyAttBody = [
          {
            file: "profile1.png",
            attachment: {
              key: attachmentCopyKey1,
              description: `this is MY file with key ${attachmentKey1}`,
            },
            resource: {
              href: resourceCopyHref,
            },
          },
        ];
        const copyAttResult = await needle(
          "post",
          `${base + type}/attachments/copy`,
          copyAttBody,
          { json: true }
        );
        console.log(copyAttResult.statusCode);
        console.log(copyAttResult.body);

        assert.equal(copyAttResult.statusCode, 400);
        assert.equal(
          copyAttResult.body.errors[0].code,
          "missing.json.fileHref"
        );
      });

      it("missing body should result in proper error", async () => {
        const copyAttResult = await needle(
          "post",
          `${base + type}/attachments/copy`,
          undefined,
          { json: true }
        );
        console.log(copyAttResult.statusCode);
        console.log(copyAttResult.body);

        assert.equal(copyAttResult.statusCode, 400);
        assert.equal(
          copyAttResult.body.errors[0].code,
          "missing.json.body.attachment"
        );
      });
    });
  });
};

// No testcase for customRouteForPreSignedUpload provided yet as it is not used
// TODO: add test cases for handleMultipleUploadsTogether (used in content api; or adapt content-api to get plugin usage more uniform!)
// TODO : test security??
// TODO : more error cases?

// TODO : Define resource with S3 and file storage to test both
// TODO : When BLOB database storage is implemented, also add a resource on that with tests
// TODO : Implement + check after & before function (with database access) on GET, PUT and DELETE.
