"use strict";

var clc = require("cli-color");
var ProgressBar = require("progress");

var api = require("../api");
var firestore = require("../gcp/firestore");
var { FirebaseError } = require("../error");
var logger = require("../logger");
var utils = require("../utils");

// Datastore allowed numeric IDs where Firestore only allows strings. Numeric IDs are
// exposed to Firestore as __idNUM__, so this is the lowest possible negative numeric
// value expressed in that format.
var MIN_ID = "__id-9223372036854775808__";

/**
 * Construct a new Firestore delete operation.
 *
 * @constructor
 * @param {string} project the Firestore project ID.
 * @param {string} path path to a document or collection.
 * @param {boolean} options.recursive true if the delete should be recursive.
 * @param {boolean} options.shallow true if the delete should be shallow (non-recursive).
 * @param {boolean} options.allCollections true if the delete should universally remove all collections and docs.
 */
function FirestoreDelete(project, path, options) {
  this.project = project;
  this.path = path || "";
  this.recursive = Boolean(options.recursive);
  this.shallow = Boolean(options.shallow);
  this.allCollections = Boolean(options.allCollections);

  // Remove any leading or trailing slashes from the path
  this.path = this.path.replace(/(^\/+|\/+$)/g, "");

  this.allDescendants = this.recursive;
  this.root = "projects/" + project + "/databases/(default)/documents";

  var segments = this.path.split("/");
  this.isDocumentPath = segments.length % 2 === 0;
  this.isCollectionPath = !this.isDocumentPath;

  // this.parent is the closest ancestor document to the location we're deleting.
  // If we are deleting a document, this.parent is the path of that document.
  // If we are deleting a collection, this.parent is the path of the document
  // containing that collection (or the database root, if it is a root collection).
  this.parent = this.root;
  if (this.isCollectionPath) {
    segments.pop();
  }
  if (segments.length > 0) {
    this.parent += "/" + segments.join("/");
  }

  // When --all-collections is passed any other flags or arguments are ignored
  if (!options.allCollections) {
    this._validateOptions();
  }
}

/**
 * Validate all options, throwing an exception for any fatal errors.
 */
FirestoreDelete.prototype._validateOptions = function() {
  if (this.recursive && this.shallow) {
    throw new FirebaseError("Cannot pass recursive and shallow options together.");
  }

  if (this.isCollectionPath && !this.recursive && !this.shallow) {
    throw new FirebaseError("Must pass recursive or shallow option when deleting a collection.");
  }

  var pieces = this.path.split("/");

  if (pieces.length === 0) {
    throw new FirebaseError("Path length must be greater than zero.");
  }

  var hasEmptySegment = pieces.some(function(piece) {
    return piece.length === 0;
  });

  if (hasEmptySegment) {
    throw new FirebaseError("Path must not have any empty segments.");
  }
};

/**
 * Construct a StructuredQuery to find descendant documents of a collection.
 *
 * See:
 * https://firebase.google.com/docs/firestore/reference/rest/v1beta1/StructuredQuery
 *
 * @param {boolean} allDescendants true if subcollections should be included.
 * @param {number} batchSize maximum number of documents to target (limit).
 * @param {string=} startAfter document name to start after (optional).
 * @return {object} a StructuredQuery.
 */
FirestoreDelete.prototype._collectionDescendantsQuery = function(
  allDescendants,
  batchSize,
  startAfter
) {
  var nullChar = String.fromCharCode(0);

  var startAt = this.root + "/" + this.path + "/" + MIN_ID;
  var endAt = this.root + "/" + this.path + nullChar + "/" + MIN_ID;

  var where = {
    compositeFilter: {
      op: "AND",
      filters: [
        {
          fieldFilter: {
            field: {
              fieldPath: "__name__",
            },
            op: "GREATER_THAN_OR_EQUAL",
            value: {
              referenceValue: startAt,
            },
          },
        },
        {
          fieldFilter: {
            field: {
              fieldPath: "__name__",
            },
            op: "LESS_THAN",
            value: {
              referenceValue: endAt,
            },
          },
        },
      ],
    },
  };

  var query = {
    structuredQuery: {
      where: where,
      limit: batchSize,
      from: [
        {
          allDescendants: allDescendants,
        },
      ],
      select: {
        fields: [{ fieldPath: "__name__" }],
      },
      orderBy: [{ field: { fieldPath: "__name__" } }],
    },
  };

  if (startAfter) {
    query.structuredQuery.startAt = {
      values: [{ referenceValue: startAfter }],
      before: false,
    };
  }

  return query;
};

/**
 * Construct a StructuredQuery to find descendant documents of a document.
 * The document itself will not be included
 * among the results.
 *
 * See:
 * https://firebase.google.com/docs/firestore/reference/rest/v1beta1/StructuredQuery
 *
 * @param {boolean} allDescendants true if subcollections should be included.
 * @param {number} batchSize maximum number of documents to target (limit).
 * @param {string=} startAfter document name to start after (optional).
 * @return {object} a StructuredQuery.
 */
FirestoreDelete.prototype._docDescendantsQuery = function(allDescendants, batchSize, startAfter) {
  var query = {
    structuredQuery: {
      limit: batchSize,
      from: [
        {
          allDescendants: allDescendants,
        },
      ],
      select: {
        fields: [{ fieldPath: "__name__" }],
      },
      orderBy: [{ field: { fieldPath: "__name__" } }],
    },
  };

  if (startAfter) {
    query.structuredQuery.startAt = {
      values: [{ referenceValue: startAfter }],
      before: false,
    };
  }

  return query;
};

/**
 * Query for a batch of 'descendants' of a given path.
 *
 * For document format see:
 * https://firebase.google.com/docs/firestore/reference/rest/v1beta1/Document
 *
 * @param {boolean} allDescendants true if subcollections should be included,
 * @param {number} batchSize the maximum size of the batch.
 * @param {string=} startAfter the name of the document to start after (optional).
 * @return {Promise<object[]>} a promise for an array of documents.
 */
FirestoreDelete.prototype._getDescendantBatch = function(allDescendants, batchSize, startAfter) {
  var url = this.parent + ":runQuery";
  var body;
  if (this.isDocumentPath) {
    body = this._docDescendantsQuery(allDescendants, batchSize, startAfter);
  } else {
    body = this._collectionDescendantsQuery(allDescendants, batchSize, startAfter);
  }

  return api
    .request("POST", "/v1beta1/" + url, {
      auth: true,
      data: body,
      origin: api.firestoreOrigin,
    })
    .then(function(res) {
      // Return the 'document' property for each element in the response,
      // where it exists.
      return res.body
        .filter(function(x) {
          return x.document;
        })
        .map(function(x) {
          return x.document;
        });
    });
};

/**
 * Progress bar shared by the class.
 */
FirestoreDelete.progressBar = new ProgressBar("Deleted :current docs (:rate docs/s)", {
  total: Number.MAX_SAFE_INTEGER,
});

/**
 * Repeatedly query for descendants of a path and delete them in batches
 * until no documents remain.
 *
 * @return {Promise} a promise for the entire operation.
 */
FirestoreDelete.prototype._recursiveBatchDelete = function() {
  var self = this;

  // Tunable deletion parameters
  var readBatchSize = 1000;
  var deleteBatchSize = 50;
  var maxPendingDeletes = 10;
  var maxQueueSize = deleteBatchSize * maxPendingDeletes * 2;

  // All temporary variables for the deletion queue.
  var queue = [];
  var numPendingDeletes = 0;
  var pagesRemaining = true;
  var pageIncoming = false;
  var lastDocName;

  var failures = [];
  var retried = {};
  var lastError = null;

  var queueLoop = function() {
    if (queue.length == 0 && numPendingDeletes == 0 && !pagesRemaining) {
      return true;
    }

    if (failures.length > 0) {
      logger.debug("Found " + failures.length + " failed deletes, failing.");
      return true;
    }

    if (queue.length <= maxQueueSize && pagesRemaining && !pageIncoming) {
      pageIncoming = true;

      self
        ._getDescendantBatch(self.allDescendants, readBatchSize, lastDocName)
        .then(function(docs) {
          pageIncoming = false;

          if (docs.length == 0) {
            pagesRemaining = false;
            return;
          }

          queue = queue.concat(docs);
          lastDocName = docs[docs.length - 1].name;
        })
        .catch(function(e) {
          console.error("Failed to fetch page after " + lastDocName, e);
          pageIncoming = false;
          throw e;
        });
    }

    if (numPendingDeletes > maxPendingDeletes) {
      return false;
    }

    if (queue.length == 0) {
      return false;
    }

    var toDelete = [];
    var numToDelete = Math.min(deleteBatchSize, queue.length);

    for (var i = 0; i < numToDelete; i++) {
      toDelete.push(queue.shift());
    }

    numPendingDeletes++;
    firestore
      .deleteDocuments(self.project, toDelete)
      .then(function(numDeleted) {
        FirestoreDelete.progressBar.tick(numDeleted);
        numPendingDeletes--;
      })
      .catch(function(e) {
        // For server errors, retry if the document has not yet been retried.
        if (e.status >= 500 && e.status < 600) {
          console.warn("Server error deleting doc batch", e);
          if (e.context) console.warn("Response:", e.context.response.toJSON());
          lastError = e;

          // Retry each doc up to one time
          toDelete.forEach(function(doc) {
            if (retried[doc.name]) {
              console.debug("Failed to delete doc " + doc.name + " multiple times.");
              failures.push(doc.name);
            } else {
              retried[doc.name] = true;
              queue.push(doc);
            }
          });
        } else {
          console.error("Fatal error deleting docs ", e);
          failures = failures.concat(toDelete);
          lastError = e;
        }

        numPendingDeletes--;
      });

    return false;
  };

  return new Promise(function(resolve, reject) {
    var intervalId = setInterval(function() {
      if (queueLoop()) {
        clearInterval(intervalId);

        if (failures.length == 0) {
          resolve();
        } else {
          var error = Error("Failed to delete documents");
          error.lastError = lastError;
          error.failures = failures;
          throw error;
          reject("Failed to delete documents " + failures);
        }
      }
    }, 0);
  });
};

/**
 * Delete everything under a given path. If the path represents
 * a document the document is deleted and then all descendants
 * are deleted.
 *
 * @return {Promise} a promise for the entire operation.
 */
FirestoreDelete.prototype._deletePath = function() {
  var self = this;
  var initialDelete;
  if (this.isDocumentPath) {
    var doc = { name: this.root + "/" + this.path };
    initialDelete = firestore.deleteDocument(doc).catch(function(err) {
      logger.debug("deletePath:initialDelete:error", err);
      if (self.allDescendants) {
        // On a recursive delete, we are insensitive to
        // failures of the initial delete
        return Promise.resolve();
      }

      // For a shallow delete, this error is fatal.
      return utils.reject("Unable to delete " + clc.cyan(this.path));
    });
  } else {
    initialDelete = Promise.resolve();
  }

  return initialDelete.then(function() {
    return self._recursiveBatchDelete();
  });
};

/**
 * Delete an entire database by finding and deleting each collection.
 *
 * @return {Promise} a promise for all of the operations combined.
 */
FirestoreDelete.prototype.deleteDatabase = function() {
  var self = this;
  return firestore
    .listCollectionIds(this.project)
    .catch(function(err) {
      logger.debug("deleteDatabase:listCollectionIds:error", err);
      return utils.reject("Unable to list collection IDs");
    })
    .then(function(collectionIds) {
      var promises = [];

      logger.info("Deleting the following collections: " + clc.cyan(collectionIds.join(", ")));

      for (var i = 0; i < collectionIds.length; i++) {
        var collectionId = collectionIds[i];
        var deleteOp = new FirestoreDelete(self.project, collectionId, {
          recursive: true,
        });

        promises.push(deleteOp.execute());
      }

      return Promise.all(promises);
    });
};

/**
 * Check if a path has any children. Useful for determining
 * if deleting a path will affect more than one document.
 *
 * @return {Promise<boolean>} a promise that retruns true if the path has
 * children and false otherwise.
 */
FirestoreDelete.prototype.checkHasChildren = function() {
  return this._getDescendantBatch(true, 1).then(function(docs) {
    return docs.length > 0;
  });
};

/**
 * Run the delete operation.
 */
FirestoreDelete.prototype.execute = function() {
  var verifyRecurseSafe;
  if (this.isDocumentPath && !this.recursive && !this.shallow) {
    verifyRecurseSafe = this.checkHasChildren().then(function(multiple) {
      if (multiple) {
        return utils.reject("Document has children, must specify -r or --shallow.", { exit: 1 });
      }
    });
  } else {
    verifyRecurseSafe = Promise.resolve();
  }

  var self = this;
  return verifyRecurseSafe.then(function() {
    return self._deletePath();
  });
};

module.exports = FirestoreDelete;
