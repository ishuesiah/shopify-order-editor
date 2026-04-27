require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.SHOP_DOMAIN ? [
    `https://${process.env.SHOP_DOMAIN}`,
    'https://hemlock-oak.myshopify.com'
  ] : '*',
  credentials: true
}));

// Shopify API configuration
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

// Helper function to make Shopify Admin API requests
async function shopifyAdminAPI(query, variables = {}) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error('Shopify API Error:', data.errors);
    throw new Error(data.errors[0]?.message || 'Shopify API error');
  }

  return data;
}

// Verify customer owns the order
async function verifyOrderOwnership(orderId, customerEmail) {
  const query = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        customer {
          email
        }
      }
    }
  `;

  const result = await shopifyAdminAPI(query, {
    id: `gid://shopify/Order/${orderId}`
  });

  const order = result.data?.order;
  if (!order) return false;

  const orderEmail = order.customer?.email || order.email;
  return orderEmail?.toLowerCase() === customerEmail?.toLowerCase();
}

// Get variant details by ID (for adding custom items with properties)
async function getVariantDetails(variantId) {
  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        title
        sku
        price
        product {
          title
        }
      }
    }
  `;

  const gidVariantId = variantId.startsWith('gid://') ? variantId : `gid://shopify/ProductVariant/${variantId}`;
  const result = await shopifyAdminAPI(query, { id: gidVariantId });
  return result.data?.productVariant;
}

// Search for product by title
async function searchProduct(title) {
  const query = `
    query searchProducts($query: String!) {
      products(first: 5, query: $query) {
        edges {
          node {
            id
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await shopifyAdminAPI(query, { query: title });
  return result.data?.products?.edges || [];
}

// Get existing customization metafield
async function getCustomizationMetafield(orderId) {
  const query = `
    query getOrderMetafield($id: ID!) {
      order(id: $id) {
        metafield(namespace: "custom", key: "customization_overrides") {
          value
        }
      }
    }
  `;

  try {
    const result = await shopifyAdminAPI(query, { id: orderId });
    const value = result.data?.order?.metafield?.value;
    return value ? JSON.parse(value) : {};
  } catch (e) {
    return {};
  }
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get order details - also syncs active line items metafield
app.post('/api/order/details', async (req, res) => {
  try {
    const { orderId, customerEmail } = req.body;

    if (!orderId || !customerEmail) {
      return res.status(400).json({ error: 'Missing orderId or customerEmail' });
    }

    const isOwner = await verifyOrderOwnership(orderId, customerEmail);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this order' });
    }

    const gidOrderId = `gid://shopify/Order/${orderId}`;

    // Fetch order with currentQuantity to detect removed items
    const query = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          displayFinancialStatus
          displayFulfillmentStatus
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                quantity
                currentQuantity
                variant {
                  id
                  title
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }
    `;

    const result = await shopifyAdminAPI(query, { id: gidOrderId });
    const order = result.data.order;

    // Build list of active line item IDs (currentQuantity > 0)
    const activeLineItemIds = [];
    for (const edge of order.lineItems?.edges || []) {
      const item = edge.node;
      if (item.currentQuantity > 0) {
        // Extract numeric ID from gid://shopify/LineItem/123456
        const numericId = item.id.split('/').pop();
        activeLineItemIds.push(numericId);
      }
    }

    // Save active line items to metafield so frontend Liquid can access it
    const metafieldQuery = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }
    `;

    await shopifyAdminAPI(metafieldQuery, {
      input: {
        id: gidOrderId,
        metafields: [{
          namespace: "custom",
          key: "active_line_items",
          value: JSON.stringify(activeLineItemIds),
          type: "json"
        }]
      }
    });

    console.log('Synced active line items:', activeLineItemIds);

    res.json({ success: true, order, activeLineItemIds });
  } catch (error) {
    console.error('Error getting order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Edit order - update customizations
app.post('/api/order/edit', async (req, res) => {
  try {
    const { orderId, customerEmail, lineItemEdits } = req.body;

    if (!orderId || !customerEmail) {
      return res.status(400).json({ error: 'Missing orderId or customerEmail' });
    }

    if (!lineItemEdits || lineItemEdits.length === 0) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    // Verify ownership
    const isOwner = await verifyOrderOwnership(orderId, customerEmail);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this order' });
    }

    const gidOrderId = `gid://shopify/Order/${orderId}`;

    // Get existing metafield data (tracks what we previously added)
    const existingMetafield = await getCustomizationMetafield(gidOrderId);
    console.log('Existing metafield:', JSON.stringify(existingMetafield, null, 2));

    // Get order details with all line items
    const orderQuery = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                quantity
                variant {
                  id
                }
                customAttributes {
                  key
                  value
                }
              }
            }
          }
        }
      }
    `;

    const orderResult = await shopifyAdminAPI(orderQuery, { id: gidOrderId });
    const allLineItems = orderResult.data?.order?.lineItems?.edges || [];

    // Begin order edit
    const beginEditQuery = `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 100) {
              edges {
                node {
                  id
                  title
                  quantity
                  variant {
                    id
                  }
                  customAttributes {
                    key
                    value
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const beginResult = await shopifyAdminAPI(beginEditQuery, { id: gidOrderId });

    if (beginResult.data.orderEditBegin.userErrors?.length > 0) {
      throw new Error(beginResult.data.orderEditBegin.userErrors[0].message);
    }

    const calculatedOrder = beginResult.data.orderEditBegin.calculatedOrder;
    const calculatedOrderId = calculatedOrder.id;
    const calculatedLineItems = calculatedOrder.lineItems?.edges || [];

    console.log('Calculated line items:', calculatedLineItems.map(li => ({
      id: li.node.id,
      title: li.node.title,
      variantId: li.node.variant?.id,
      qty: li.node.quantity
    })));

    let madeChanges = false;
    const removedLineItemIds = new Set();
    const addedItems = [];
    // Deep copy the existing metafield data
    const newMetafieldData = JSON.parse(JSON.stringify(existingMetafield));

    // Process each parent item edit
    for (const edit of lineItemEdits) {
      const parentLineItemId = edit.lineItemId;
      console.log('\n=== Processing parent:', parentLineItemId, '===');

      // Find parent line item to get its variant ID and custom attributes
      const parentItem = allLineItems.find(li => li.node.id.includes(parentLineItemId));
      const parentVariantId = parentItem?.node?.variant?.id;
      const parentVariantIdShort = parentVariantId?.split('/').pop();
      const parentAttrs = parentItem?.node?.customAttributes || [];

      // Get Duo Pair info from parent (e.g., "Duo 1" or "Duo 2")
      const duoPairAttr = parentAttrs.find(a => a.key === 'Duo Pair');
      const duoPairValue = duoPairAttr?.value || 'Duo 1';

      console.log('Parent variant ID:', parentVariantId);
      console.log('Parent Duo Pair:', duoPairValue);

      if (!parentVariantId) {
        console.log('Could not find parent variant ID, skipping');
        continue;
      }

      // Initialize metafield entry for this parent
      if (!newMetafieldData[parentLineItemId]) {
        newMetafieldData[parentLineItemId] = {};
      }

      const customizations = Array.isArray(edit.customizations) ? edit.customizations : [];
      console.log('Customizations to process:', customizations);

      // Step 1: Find ALL accessories to remove for this parent
      // This includes:
      // - Original accessories (linked via _duo_parent_variant)
      // - Previously added accessories (tracked via metafield variantIds)

      const accessoriesToRemove = [];

      // Find original accessories linked via _duo_parent_variant
      for (const li of calculatedLineItems) {
        if (removedLineItemIds.has(li.node.id)) continue;
        if (li.node.quantity <= 0) continue;

        const attrs = li.node.customAttributes || [];
        const linkedTo = attrs.find(a => a.key === '_duo_parent_variant')?.value;

        if (linkedTo === parentVariantIdShort) {
          const titleLower = li.node.title.toLowerCase();
          if (titleLower.includes('charm') || titleLower.includes('pocket')) {
            console.log('Found original accessory to remove:', li.node.title, li.node.id);
            accessoriesToRemove.push(li.node);
          }
        }
      }

      // Find previously added accessories (from metafield) by variant ID
      const prevData = existingMetafield[parentLineItemId] || {};
      for (const [customType, customData] of Object.entries(prevData)) {
        if (customData && customData.variantId) {
          const prevVariantGid = `gid://shopify/ProductVariant/${customData.variantId}`;
          // Find line item with this variant that hasn't been marked for removal
          for (const li of calculatedLineItems) {
            if (removedLineItemIds.has(li.node.id)) continue;
            if (li.node.quantity <= 0) continue;
            if (li.node.variant?.id === prevVariantGid) {
              // Check it's not already in our remove list
              if (!accessoriesToRemove.find(a => a.id === li.node.id)) {
                console.log('Found previously added accessory to remove:', li.node.title, li.node.id, 'type:', customType);
                accessoriesToRemove.push(li.node);
                break; // Only remove one per type
              }
            }
          }
        }
      }

      // Step 2: Remove all found accessories
      for (const accessory of accessoriesToRemove) {
        if (removedLineItemIds.has(accessory.id)) continue;
        removedLineItemIds.add(accessory.id);

        console.log('Removing:', accessory.title, accessory.id);
        const removeQuery = `
          mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
              calculatedOrder { id }
              userErrors { field message }
            }
          }
        `;

        const removeResult = await shopifyAdminAPI(removeQuery, {
          id: calculatedOrderId,
          lineItemId: accessory.id,
          quantity: 0
        });

        if (removeResult.data?.orderEditSetQuantity?.userErrors?.length > 0) {
          console.error('Remove error:', removeResult.data.orderEditSetQuantity.userErrors);
        }
        madeChanges = true;
      }

      // Step 3: First update the metafield with new selections
      for (const custom of customizations) {
        const customType = custom.type;
        const newValue = custom.title;
        const newVariantId = custom.variantId;

        console.log('Updating metafield for:', customType, '=', newValue, 'variantId:', newVariantId);

        if (newValue === 'None' || !newValue) {
          newMetafieldData[parentLineItemId][customType] = { title: 'None', variantId: null };
        } else {
          newMetafieldData[parentLineItemId][customType] = {
            title: newValue,
            variantId: newVariantId || null
          };
        }
        madeChanges = true;
      }

      // Step 4: Add ALL accessories from the final merged metafield state
      // This ensures Shopify matches what the metafield says
      const finalCustomizations = newMetafieldData[parentLineItemId] || {};
      console.log('Final customizations for this parent:', finalCustomizations);

      // Aggregate quantities by variantId to handle duplicate charms
      // e.g., if both firstRibbonCharm and secondRibbonCharm are "Floriculture Charm",
      // we need to add quantity: 2, not two separate quantity: 1 calls
      const variantQuantities = {};

      for (const [customType, customData] of Object.entries(finalCustomizations)) {
        // Handle both old format (string) and new format ({title, variantId})
        let title, variantId;
        if (typeof customData === 'object' && customData !== null) {
          title = customData.title;
          variantId = customData.variantId;
        } else {
          title = customData;
          variantId = null;
        }

        console.log('Processing from final state:', customType, '=', title, 'variantId:', variantId);

        if (!title || title === 'None' || !variantId) {
          console.log('Skipping - no title or variantId');
          continue;
        }

        // Aggregate by variantId
        if (!variantQuantities[variantId]) {
          variantQuantities[variantId] = { title, quantity: 0, types: [] };
        }
        variantQuantities[variantId].quantity += 1;
        variantQuantities[variantId].types.push(customType);
      }

      console.log('Aggregated variant quantities:', variantQuantities);

      // Now add each unique variant with the correct quantity
      // Check if variant already exists on order WITH qty > 0 - if so, use setQuantity instead of addVariant
      // Items with qty: 0 are considered "removed" by Shopify and can't be edited
      for (const [variantId, data] of Object.entries(variantQuantities)) {
        const gidVariantId = `gid://shopify/ProductVariant/${variantId}`;

        // Check if this variant already exists on the order with qty > 0 (not removed)
        const existingLineItem = calculatedLineItems.find(li =>
          li.node.variant?.id === gidVariantId && li.node.quantity > 0
        );

        if (existingLineItem) {
          // Variant already exists with qty > 0 - use setQuantity to update it
          console.log('Setting quantity for existing item:', data.title, 'x', data.quantity, existingLineItem.node.id);

          const setQtyQuery = `
            mutation orderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
              orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
                calculatedOrder { id }
                userErrors { field message }
              }
            }
          `;

          const setQtyResult = await shopifyAdminAPI(setQtyQuery, {
            id: calculatedOrderId,
            lineItemId: existingLineItem.node.id,
            quantity: data.quantity
          });

          if (setQtyResult.data?.orderEditSetQuantity?.userErrors?.length > 0) {
            console.error('Set quantity error:', setQtyResult.data.orderEditSetQuantity.userErrors);
            addedItems.push({ types: data.types, title: data.title, variantId, quantity: data.quantity, error: setQtyResult.data.orderEditSetQuantity.userErrors });
          } else {
            console.log('Set quantity successfully for:', data.title);
            addedItems.push({ types: data.types, title: data.title, variantId, quantity: data.quantity, lineItemId: existingLineItem.node.id, parentVariantId: parentVariantIdShort, duoPair: duoPairValue });
          }
        } else {
          // Variant doesn't exist - add it
          console.log('Adding new item:', data.title, 'x', data.quantity, gidVariantId, 'linked to parent:', parentVariantIdShort, 'Duo Pair:', duoPairValue, 'types:', data.types);

          const addQuery = `
            mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
              orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
                calculatedOrder { id }
                calculatedLineItem { id }
                userErrors { field message }
              }
            }
          `;

          const addResult = await shopifyAdminAPI(addQuery, {
            id: calculatedOrderId,
            variantId: gidVariantId,
            quantity: data.quantity
          });

          if (addResult.data?.orderEditAddVariant?.userErrors?.length > 0) {
            console.error('Add error:', addResult.data.orderEditAddVariant.userErrors);
            addedItems.push({ types: data.types, title: data.title, variantId, quantity: data.quantity, error: addResult.data.orderEditAddVariant.userErrors });
          } else {
            console.log('Added successfully, line item:', addResult.data?.orderEditAddVariant?.calculatedLineItem?.id);
            addedItems.push({ types: data.types, title: data.title, variantId, quantity: data.quantity, lineItemId: addResult.data?.orderEditAddVariant?.calculatedLineItem?.id, parentVariantId: parentVariantIdShort, duoPair: duoPairValue });
          }
        }
      }
    }

    if (!madeChanges) {
      return res.json({
        success: true,
        message: 'No changes needed'
      });
    }

    // Commit the edit
    const commitQuery = `
      mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer) {
          order {
            id
            name
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const commitResult = await shopifyAdminAPI(commitQuery, {
      id: calculatedOrderId,
      notifyCustomer: false
    });

    if (commitResult.data.orderEditCommit.userErrors?.length > 0) {
      throw new Error(commitResult.data.orderEditCommit.userErrors[0].message);
    }

    console.log('Order edit committed successfully');
    console.log('Saving metafield:', JSON.stringify(newMetafieldData, null, 2));

    // Save metafield with all customization data
    const metafieldQuery = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }
    `;

    await shopifyAdminAPI(metafieldQuery, {
      input: {
        id: gidOrderId,
        metafields: [{
          namespace: "custom",
          key: "customization_overrides",
          value: JSON.stringify(newMetafieldData),
          type: "json"
        }]
      }
    });

    // Update Gift Note custom attribute (for ShipStation) instead of order note
    // Keep the "Charm(s) handplaced by:" line from existing Gift Note
    const getOrderAttributesQuery = `
      query getOrderAttributes($id: ID!) {
        order(id: $id) {
          customAttributes {
            key
            value
          }
        }
      }
    `;

    const orderAttributesResult = await shopifyAdminAPI(getOrderAttributesQuery, { id: gidOrderId });
    const existingAttributes = orderAttributesResult.data?.order?.customAttributes || [];

    // Find existing Gift Note and extract "Charm(s) handplaced by:" line
    const giftNoteAttr = existingAttributes.find(attr => attr.key === 'Gift Note');
    let handplacedByLine = '';
    if (giftNoteAttr?.value) {
      // Look for the handplaced by line (with or without underscores/dashes before it)
      const handplacedMatch = giftNoteAttr.value.match(/[_\-]*\s*Charm\(s\) handplaced by:.*$/im);
      if (handplacedMatch) {
        handplacedByLine = '\n\n________________________________________\nCharm(s) handplaced by: _________________________';
      }
    }

    // Build new Gift Note with customizations
    let newGiftNote = '--- CUSTOMIZATION DETAILS (Updated via Order Editor) ---\n';

    for (const [parentLineItemId, customizations] of Object.entries(newMetafieldData)) {
      const parentItem = allLineItems.find(li => li.node.id.includes(parentLineItemId));
      const parentTitle = parentItem?.node?.title || 'Unknown Item';
      const parentAttrs = parentItem?.node?.customAttributes || [];
      const duoPairAttr = parentAttrs.find(a => a.key === 'Duo Pair');
      const duoPairValue = duoPairAttr?.value || '';

      const hasCustomizations = Object.entries(customizations).some(([_, customData]) => {
        const title = typeof customData === 'object' ? customData.title : customData;
        return title && title !== 'None';
      });

      if (hasCustomizations) {
        newGiftNote += `\n${parentTitle}${duoPairValue ? ` (${duoPairValue})` : ''}:\n`;

        for (const [customType, customData] of Object.entries(customizations)) {
          const title = typeof customData === 'object' ? customData.title : customData;
          if (title && title !== 'None') {
            const typeLabel = customType.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            newGiftNote += `  - ${typeLabel}: ${title}\n`;
          }
        }
      }
    }

    // Add the handplaced by line at the end
    newGiftNote += handplacedByLine;

    // Build updated custom attributes array
    const updatedAttributes = existingAttributes
      .filter(attr => attr.key !== 'Gift Note')
      .map(attr => ({ key: attr.key, value: attr.value }));

    updatedAttributes.push({ key: 'Gift Note', value: newGiftNote });

    // Update order custom attributes
    const updateAttributesQuery = `
      mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id }
          userErrors { field message }
        }
      }
    `;

    await shopifyAdminAPI(updateAttributesQuery, {
      input: {
        id: gidOrderId,
        customAttributes: updatedAttributes
      }
    });

    console.log('Gift Note updated with customization details');

    res.json({
      success: true,
      message: 'Order customizations updated',
      order: commitResult.data.orderEditCommit.order,
      debug: {
        removedCount: removedLineItemIds.size,
        addedItems: addedItems,
        metafieldSaved: newMetafieldData,
        giftNoteUpdated: true
      }
    });
  } catch (error) {
    console.error('Error editing order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add item to order
app.post('/api/order/add-item', async (req, res) => {
  try {
    const { orderId, customerEmail, variantId, quantity } = req.body;

    if (!orderId || !customerEmail || !variantId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isOwner = await verifyOrderOwnership(orderId, customerEmail);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this order' });
    }

    const gidOrderId = `gid://shopify/Order/${orderId}`;
    const gidVariantId = `gid://shopify/ProductVariant/${variantId}`;

    // Begin order edit
    const beginEditQuery = `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `;

    const beginResult = await shopifyAdminAPI(beginEditQuery, { id: gidOrderId });

    if (beginResult.data.orderEditBegin.userErrors?.length > 0) {
      throw new Error(beginResult.data.orderEditBegin.userErrors[0].message);
    }

    const calculatedOrderId = beginResult.data.orderEditBegin.calculatedOrder.id;

    // Add variant
    const addVariantQuery = `
      mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }
    `;

    const addResult = await shopifyAdminAPI(addVariantQuery, {
      id: calculatedOrderId,
      variantId: gidVariantId,
      quantity: quantity || 1
    });

    if (addResult.data.orderEditAddVariant.userErrors?.length > 0) {
      throw new Error(addResult.data.orderEditAddVariant.userErrors[0].message);
    }

    // Commit
    const commitQuery = `
      mutation orderEditCommit($id: ID!, $notifyCustomer: Boolean) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer) {
          order { id name }
          userErrors { field message }
        }
      }
    `;

    const commitResult = await shopifyAdminAPI(commitQuery, {
      id: calculatedOrderId,
      notifyCustomer: true
    });

    if (commitResult.data.orderEditCommit.userErrors?.length > 0) {
      throw new Error(commitResult.data.orderEditCommit.userErrors[0].message);
    }

    res.json({
      success: true,
      message: 'Item added to order',
      order: commitResult.data.orderEditCommit.order
    });
  } catch (error) {
    console.error('Error adding item to order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search products
app.get('/api/products/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Missing search query' });
    }

    const products = await searchProduct(q);
    res.json({ success: true, products });
  } catch (error) {
    console.error('Error searching products:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get products from a collection
app.get('/api/collection/:handle', async (req, res) => {
  try {
    const { handle } = req.params;

    const query = `
      query getCollection($handle: String!) {
        collectionByHandle(handle: $handle) {
          id
          title
          products(first: 50) {
            edges {
              node {
                id
                title
                handle
                variants(first: 5) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
                featuredImage {
                  url
                }
              }
            }
          }
        }
      }
    `;

    const result = await shopifyAdminAPI(query, { handle });
    res.json({ success: true, collection: result.data.collectionByHandle });
  } catch (error) {
    console.error('Error getting collection:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Order Editor API running on port ${PORT}`);
  console.log(`Shopify Store: ${SHOPIFY_STORE || 'NOT SET'}`);
});
