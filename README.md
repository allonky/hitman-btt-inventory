# hitman-btt-inventory

Sold-slot tracker for the Hitman BTT sponsor page. Two Vercel functions plus a Vercel Blob store.

- `api/paypal-webhook` receives PayPal `PAYMENT.CAPTURE.COMPLETED`, verifies the signature against PayPal's cert (needs env `PAYPAL_WEBHOOK_ID`, no secret), adds the SKUs in `custom_id` to `sold.json`.
- `api/sold` returns `{"sold":{...}}` with open CORS. The page reads it on load.

Setup once: connect a Blob store to the project (injects `BLOB_READ_WRITE_TOKEN`), register the webhook URL in the PayPal live app, set `PAYPAL_WEBHOOK_ID`, redeploy.
Manual override: `sold.json` in the page repo, same shape, merged with the API (higher number wins).
