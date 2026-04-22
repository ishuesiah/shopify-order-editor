# Shopify Order Editor Backend

A backend API that allows customers to edit their pre-orders directly from your Shopify store.

## Features

- Edit customizations on existing order items (charms, pockets, etc.)
- Add new products to existing orders
- Automatic order updates via Shopify Admin API
- Customer verification (only order owners can edit)

## Quick Deploy to Vercel

1. **Push to GitHub** (or use Vercel CLI):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/shopify-order-editor.git
   git push -u origin main
   ```

2. **Deploy on Vercel**:
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your GitHub repository
   - Add Environment Variables:
     - `SHOPIFY_STORE`: `hemlock-oak`
     - `SHOPIFY_ACCESS_TOKEN`: `your_admin_api_token`
     - `SHOP_DOMAIN`: `hemlock-oak.myshopify.com`
   - Click "Deploy"

3. **Copy your Vercel URL** (e.g., `https://shopify-order-editor.vercel.app`)

## Configure in Shopify Theme

1. Go to **Shopify Admin > Online Store > Themes**
2. Click **Customize** on your theme
3. Navigate to the **Pre-orders** page
4. Click on the **Customer pre-orders** section
5. Enter your Vercel URL in the **"Order Editor API URL"** field
6. Save

## API Endpoints

### Health Check
```
GET /api/health
```

### Get Order Details
```
POST /api/order/details
{
  "orderId": "123456789",
  "customerEmail": "customer@example.com"
}
```

### Edit Order (Update Customizations)
```
POST /api/order/edit
{
  "orderId": "123456789",
  "customerEmail": "customer@example.com",
  "lineItemEdits": [
    {
      "productTitle": "2026 Weekly Planner",
      "lineItemId": "...",
      "customizations": {
        "firstRibbonCharm": "Leaf Charm",
        "backPocket": "None"
      }
    }
  ]
}
```

### Add Item to Order
```
POST /api/order/add-item
{
  "orderId": "123456789",
  "customerEmail": "customer@example.com",
  "variantId": "45398878126324",
  "quantity": 1
}
```

### Search Products
```
GET /api/products/search?q=planner
```

## Local Development

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

## Security Notes

- The API verifies that the customer email matches the order before allowing edits
- CORS is configured to only allow requests from your Shopify store
- Consider adding rate limiting for production use
- **IMPORTANT**: Rotate your Admin API token if it was ever exposed publicly

## Required Shopify App Permissions

Your Admin API token needs these scopes:
- `read_orders`
- `write_orders`
- `read_products`
