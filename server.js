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
const API_VERSION = '2024-01';

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

// Get order details
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

    const query = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          displayFinancialStatus
          displayFulfillmentStatus
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
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

    const result = await shopifyAdminAPI(query, {
      id: `gid://shopify/Order/${orderId}`
    });

    res.json({ success: true, order: result.data.order });
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
    const newMetafieldData = { ...existingMetafield };

    // Process each parent item edit
    for (const edit of lineItemEdits) {
      const parentLineItemId = edit.lineItemId;
      console.log('\n=== Processing parent:', parentLineItemId, '===');

      // Find parent line item to get its variant ID
      const parentItem = allLineItems.find(li => li.node.id.includes(parentLineItemId));
      const parentVariantId = parentItem?.node?.variant?.id;
      const parentVariantIdShort = parentVariantId?.split('/').pop();
      console.log('Parent variant ID:', parentVariantId);

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

      // Step 3: Add new accessories based on selections
      for (const custom of customizations) {
        const customType = custom.type;
        const newValue = custom.title;
        const newVariantId = custom.variantId;

        console.log('Processing customization:', customType, '=', newValue, 'variantId:', newVariantId);

        // Update metafield entry
        if (newValue === 'None' || !newValue) {
          newMetafieldData[parentLineItemId][customType] = { title: 'None', variantId: null };
          continue;
        }

        if (!newVariantId) {
          console.log('No variant ID for', newValue, ', skipping add');
          newMetafieldData[parentLineItemId][customType] = { title: newValue, variantId: null };
          continue;
        }

        // Add the new accessory
        const gidVariantId = `gid://shopify/ProductVariant/${newVariantId}`;
        console.log('Adding:', newValue, gidVariantId);

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
          quantity: 1
        });

        if (addResult.data?.orderEditAddVariant?.userErrors?.length > 0) {
          console.error('Add error:', addResult.data.orderEditAddVariant.userErrors);
        } else {
          console.log('Added successfully, line item:', addResult.data?.orderEditAddVariant?.calculatedLineItem?.id);
        }

        // Store in metafield with variant ID for future removal
        newMetafieldData[parentLineItemId][customType] = {
          title: newValue,
          variantId: newVariantId
        };

        madeChanges = true;
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

    res.json({
      success: true,
      message: 'Order customizations updated',
      order: commitResult.data.orderEditCommit.order
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
