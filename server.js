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
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g., 'hemlock-oak'
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

// Get product variant by ID
async function getVariantById(variantId) {
  const query = `
    query getVariant($id: ID!) {
      productVariant(id: $id) {
        id
        title
        price
        product {
          id
          title
        }
      }
    }
  `;

  const result = await shopifyAdminAPI(query, {
    id: `gid://shopify/ProductVariant/${variantId}`
  });

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

    // Verify ownership
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

    // Verify ownership
    const isOwner = await verifyOrderOwnership(orderId, customerEmail);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this order' });
    }

    const gidOrderId = `gid://shopify/Order/${orderId}`;

    // Step 1: Begin order edit
    const beginEditQuery = `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
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

    const calculatedOrderId = beginResult.data.orderEditBegin.calculatedOrder.id;

    // Step 2: Apply line item edits (for now, we'll add a note about the changes)
    // Note: Shopify's Order Edit API doesn't directly support changing line item properties
    // We'll add the changes as order notes/attributes

    // Step 3: Commit the edit
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

    // Add order note with customization changes
    if (lineItemEdits && lineItemEdits.length > 0) {
      const noteQuery = `
        mutation orderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              note
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const changesSummary = lineItemEdits
        .map(edit => `${edit.productTitle}: ${Object.entries(edit.customizations).map(([k, v]) => `${k}=${v}`).join(', ')}`)
        .join('\n');

      await shopifyAdminAPI(noteQuery, {
        input: {
          id: gidOrderId,
          note: `Customer requested customization changes:\n${changesSummary}\n\n(Updated: ${new Date().toISOString()})`
        }
      });
    }

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
    const { orderId, customerEmail, variantId, quantity, customAttributes } = req.body;

    if (!orderId || !customerEmail || !variantId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify ownership
    const isOwner = await verifyOrderOwnership(orderId, customerEmail);
    if (!isOwner) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this order' });
    }

    const gidOrderId = `gid://shopify/Order/${orderId}`;
    const gidVariantId = `gid://shopify/ProductVariant/${variantId}`;

    // Step 1: Begin order edit
    const beginEditQuery = `
      mutation orderEditBegin($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
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

    const calculatedOrderId = beginResult.data.orderEditBegin.calculatedOrder.id;

    // Step 2: Add variant to order
    const addVariantQuery = `
      mutation orderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
          calculatedOrder {
            id
            addedLineItems(first: 5) {
              edges {
                node {
                  id
                  quantity
                }
              }
            }
          }
          calculatedLineItem {
            id
          }
          userErrors {
            field
            message
          }
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

    // Step 3: Commit the edit
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
      notifyCustomer: true // Notify customer when items are added
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

// Search products (for add item functionality)
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

// Get products from a collection (for customization options)
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
