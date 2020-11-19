const Webflow = require("webflow-api");

const Config = {
  code_field: 'code',
  inventory_field: 'Inventory',
  price_field: 'Price',
  webflow: {
    limit: 100,
  },
};

function getMessages() {
  return {
    categoryMismatch: process.env['FX_ERROR_CATEGORY_MISMATCH'] ?? 'Mismatched category.',
    insufficientInventory: process.env['FX_ERROR_INSUFFICIENT_INVENTORY'] ?? 'Insufficient inventory for these items:',
    priceMismatch: process.env['FX_ERROR_PRICE_MISMATCH'] ?? 'Prices do not match.',
  }
}


/**
 * @param event the request
 * @param context context values
 * @param callback function to callback upon response
 */
async function handleRequest(event, context, callback) {
  // Validation
  if (!validation.configuration.validate()) {
    console.log('Configuration error: WEBFLOW_TOKEN not configured')
    callback(null, validation.configuration.response());
    return;
  }
  if (!validation.input.validate(event)) {
    console.log('Input error: empty body');
    callback(null, validation.input.response());
    return;
  }
  const items = extractItems(event.body);
  if (!validation.items.validate(items)) {
    const invalidItems = validation.items.response(items);
    callback(null, invalidItems);
    return;
  }

  const values = [];
  const cache = createCache();
  // Fetch information needed to validate the cart
  const concatenatedPromisses = items.reduce(
    (p, i) => p.then(
      (accum) => fetchItem(cache, i).then((fetched) => {
        values.push(fetched);
        return accum;
      }),
    ), Promise.resolve(values),
  );

  await concatenatedPromisses.then(() => {
    let failed = findMismatch(values);
    if (!failed) {
      const outOfStock = outOfStockItems(values);
      if (outOfStock) {
        failed = getMessages().insufficientInventory + " " + outOfStock;
      }
    }
    if (failed) {
      console.log(`Mismatch found: ${failed}`)
      callback(null, {
        body: JSON.stringify({ details: failed, ok: false, }),
        statusCode: 200,
      });
    } else {
      console.log('OK: payment approved - no mismatch found')
      callback(null, {
        body: JSON.stringify({ details: '', ok: true, }),
        statusCode: 200,
      });
    }
  }).catch((e) => {
    if (e.code && e.code.toString() === '429') {
      console.log('Error: Webflow rate limit reached.')
    } else {
      console.log('Error', e.code, e.message);
    }
    callback(null, {
      body: JSON.stringify({ details: "An internal error has occurred", ok: false, }),
      statusCode: 500,
    });
  });
}

/**
 * Get an option of an item.
 *
 * The option may be set in the object itself or in the fx:item_options property of the _embedded attribute
 *
 * @param {object} item the item that should have the option
 * @param {string} option to be retrieved
 * @returns {{}|{name: string, value: string|number}} name and value of the option
 *  returns an empty object if the option is not available
 */
function getOption(item, option) {
  let found = iGet(item, option);
  if (found) return { name: option, value: iGet(item, option) };
  if (item._embedded) {
    if (item._embedded['fx:item_options']) {
      found = item._embedded['fx:item_options'].find((e) => e.name.toLowerCase() === option.toLowerCase());
      if (found && found.value) return found;
    }
  }
  return {};
}


/**
 * Returns the custom key for a given option, if it is set, or the default key.
 *
 * @param {object} item where the key it to be searched (this is the item received from foxy)
 * @param {string} default_key to be checked
 * @returns {string} actual key to be used
 */
function getCustomKey(item, default_key) {
  let config_key = default_key;
  if (!default_key.endsWith('_field')) {
    config_key = `${default_key}_field`;
  }
  const custom_key = getOption(item, config_key).value;
  return custom_key ? custom_key : default_key;
}

/**
 * Retrieve an option from an item using it's custom key, if set, of the default key
 *
 * @param item the item to retrieve the custom option from
 * @param option the option to retrieve
 * @returns {{}|{name: string, value: string|number}} the retrieved option
 */
function getCustomizableOption(item, option) {
  const custom_option = getCustomKey(item, option);
  let result = getOption(item, custom_option);
  if (!result) result = {};
  return result;
}

/**
 * Creates a cache object to store collection items and avoid repeated requests to webflow within the same execution.
 *
 * This cache is not intended to persist data between requests, but to simplify getting the Webflow Items in the same request.
 *
 * @returns {{addItems: Function, cache: object, findItem: Function}} a Cache object
 */
function createCache() {
  return {
    addItems(collection, items) {
      if (!this.cache[collection]) {
        this.cache[collection] = [];
      }
      this.cache[collection] = this.cache[collection].concat(items);
    },
    cache: {},
    findItem(collection, item) {
      if (!this.cache[collection]) {
        return null;
      }
      return this.cache[collection].find(
        (e) => {
            const itemCode = iGet(item, 'code');
            const wfCode = getCustomizableOption(e, 'code').value;
            return itemCode && wfCode && wfCode.toString() === itemCode.toString();
        },
      );
    },
  };
}

/**
 * Extract items from payload received from FoxyCart
 *
 * @param {string} body of the response received from Webflow
 * @returns {Array} an array of items
 */
function extractItems(body) {
  const objBody = JSON.parse(body);
  if (objBody && objBody._embedded && objBody._embedded['fx:items']) {
    return objBody._embedded['fx:items'];
  }
  return [];
}

/**
 * Checks if item is valid
 *
 * @param item to be validated
 * @returns {boolean} valid
 */
function validItem(item) {
  return item.price
    && item.quantity
    && item.code
    && getOption(item, 'collection_id').value;
}

/**
 * Validation checks
 */
const validation = {
  configuration: {
    response: () => ({
      body: JSON.stringify({ details: 'Webflow token not configured.', ok: false }),
      statusCode: 503,
    }),
    validate: () => !!process.env.WEBFLOW_TOKEN,
  },
  input: {
    response: () => ({
      body: JSON.stringify({ details: 'Empty request.', ok: false }),
      statusCode: 400,
    }),
    validate: (event) => event && event.body,
  },
  items: {
    response: (items) => ({
      body: JSON.stringify({
        details: `Invalid items: ${items.filter(e => !validItem(e)).map((e) => e.name).join(',')}`,
        ok: false,
      }),
      statusCode: 200,
    }),
    validate: (items) => items.every(e => validItem(e)),
  }
}

/**
 * Checks if the price of the item is the same as found in WebFlow Collection
 *
 * @param comparable item received from webflow with item received from foxy embedded
 * @returns  {boolean} price is correct
 */
function isPriceCorrect(comparable) {
  const wfItem = comparable.wfItem;
  const fxItem = comparable.fxItem;
  if (!fxItem) {
    // an item with no matched item is not to be checked
    return true;
  }
  return parseFloat(fxItem.price) === parseFloat(wfItem.price);
}

/**
 * Checks if the category of the item is the same as found in WebFlow Collection
 *
 * @param comparable the enriched item
 * @returns {boolean} the categories match
 */
function correctCategory(comparable) {
  const wfItem = comparable.wfItem;
  const fxItem = comparable.fxItem;
  if (!fxItem) {
    // an item with no matched item is not to be checked
    return true;
  }
  // if no category is found in the collection item, ignore it
  const category = getCustomizableOption(wfItem, 'category');
  const categoryExists = !!Object.keys(category).length;
  if (!categoryExists) return true;
  let matchedCategory;
  const embedded = fxItem._embedded;
  if (embedded && embedded['fx:item_category']) {
    matchedCategory = embedded['fx:item_category'].code;
  }
  return matchedCategory && category.value.trim() === matchedCategory.trim();
}

/**
 * Checks if there is sufficient inventory for this purchase.
 *
 * @param comparable pair of matched items to be checked
 * @returns {boolean} the inventory is sufficient
 */
function sufficientInventory(comparable) {
  const wfItem = comparable.wfItem;
  const fxItem = comparable.fxItem;
  if (!fxItem) {
    return true;
  }
  return !Config.inventory_field ||
    Number(getOption(wfItem, getCustomKey(fxItem, 'inventory')).value) >= Number(fxItem.quantity);
}

/**
 * Retrieve the Webflow Token
 *
 * @returns {string} the WEBFLOW_TOKEN
 */
function getToken() {
  return process.env.WEBFLOW_TOKEN;
}

/**
 * Retrieve an instance of the Webflow API Client
 *
 * @returns {Webflow} the webflow api object
 */
function getWebflow() {
  return new Webflow({ token: getToken() });
}

/**
 * Stores a reference to the matched item in the item itself.
 * returns a pair of matched items that can be easily validated.
 *
 * @param webflowItem the item received from Webflow
 * @param foxyItem the item received from Foxy
 * @returns {object} a pair of comparable items
 */
function enrichFetchedItem(webflowItem, foxyItem) {
  return {fxItem: foxyItem, wfItem: webflowItem};
}

/**
 * Returns a recursive promise that fetches items from the collection until it
 * finds the item. Resolves the found item.
 *
 * Note: this method will take time linear on the size of the collection.
 * For large collections it will probably timeout.
 *
 * Webflow does not provide a documented feature for retrieving filtered
 * results based on arbitrary field.
 *
 * @param {object} cache object
 * @param {object} foxyItem received from foxycart
 * @param {number} offset number of items to skip
 * @returns {Promise<{object}>} a promise for the item from Webflow
 */
function fetchItem(cache, foxyItem, offset = 0) {
  if (offset > 1000) {
    return Promise.reject(new Error('Item not found'));
  }
  const collectionId = getCustomizableOption(foxyItem, 'collection_id').value;

  const webflow = getWebflow();
  const found = cache.findItem(collectionId, foxyItem);
  if (found) {
    return Promise.resolve(enrichFetchedItem(found, foxyItem));
  }
  return new Promise((resolve, reject) => {
    webflow.items(
      { collectionId },
      { sort: [getCustomKey(foxyItem, 'code'), 'ASC'], limit: Config.webflow.limit, offset },
    ).then((collection) => {
      cache.addItems(collectionId, collection.items);
      const match = collection.items.find(
        (e) => {
          const wfItemCode = iGet(e, getCustomKey(foxyItem, 'code'));
          if (!wfItemCode) {
            reject(new Error('Could not find the code field in Webflow'));
          }
          return wfItemCode && foxyItem.code && wfItemCode.toString() === foxyItem.code.toString()
        }
      );
      if (match) {
        resolve(enrichFetchedItem(match, foxyItem));
      } else if (collection.total > collection.offset + collection.count) {
        fetchItem(cache, foxyItem, ((offset / Config.webflow.limit) + 1) * Config.webflow.limit)
          .then((i) => resolve(i))
          .catch((e) => reject(e));
      } else {
        reject(new Error('Item not found'));
      }
    }).catch((e) => {
      reject(e);
    });
  });
}

/**
 * Checks if a particular enriched item should be evaluated or not
 *
 * @param comparable enriched item to evaluate
 * @returns {boolean} the item should be evaluated
 */
function shouldEvaluate(comparable) {
  // Ignore past subscriptions
  const fxItem = comparable.fxItem;
  if (
    fxItem.subscription_frequency
    && fxItem.subscription_start_date
  ) {
    const subscriptionStart = new Date(fxItem.subscription_start_date);
    const stripTime = (v) => v.replace(/T.*$/, '');
    // Convert to UTC, strip time and compare
    if (stripTime(new Date().toISOString()) > stripTime(subscriptionStart.toISOString())) {
      return false;
    }
  }
  // Evaluates by default
  return true;
}

/**
 * Searches for an invalid value applying a list of criteria
 *
 * @param values to find mismatches
 * @returns {boolean|string} mismatches were found
 */
function findMismatch(values) {
  const evaluations = [
    [isPriceCorrect, getMessages().priceMismatch],
    [correctCategory, getMessages().categoryMismatch],
  ];
  for (let v = 0; v < values.length; v += 1) {
    if (shouldEvaluate(values[v])) {
      for (let i = 0; i < evaluations.length; i += 1) {
        if (!evaluations[i][0](values[v])) {
          return evaluations[i][1];
        }
      }
    }
  }
  return false;
}

/**
 * Returns a list of names of products that are out of stock
 *
 * @param values comparable objects
 * @returns {string} comma separated out of stock values
 */
function outOfStockItems(values) {
  return values
    .filter(v => !sufficientInventory(v))
    .map(v => v.wfItem.name)
    .join(', ')
  ;
}

/**
 * Returns a value from an object given a case-insensitive key
 *
 * @param {object} object the object to get the value from
 * @param {string} key field to get the value from
 * @returns {any} the value stored in the key
 */
function iGet(object, key) {
  const existingKey = Object.keys(object).find(k => k.toLowerCase().trim() === key.toLowerCase().trim());
  return object[existingKey];
}

exports.handler = handleRequest;
