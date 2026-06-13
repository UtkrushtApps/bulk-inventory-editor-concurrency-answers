# Solution Steps

1. Change the client save payload from id-only rows to per-SKU rows that include sku, id, absolute price, absolute stock, and the version the user originally edited against.

2. Add an idempotency key to each save request. Send it both in the request body and as an Idempotency-Key header so a network retry can be recognized as the same logical operation.

3. On the server, add a bulk_inventory_requests table and store request id, payload hash, final response, and HTTP status. Reusing the same key with the same payload returns the stored response; reusing it with a different payload returns a 409 error.

4. Wrap bulk updates in a transaction and take a PostgreSQL advisory transaction lock for the idempotency key so concurrent retries wait for the first request to finish instead of racing it.

5. Replace the old per-item SELECT/UPDATE loop with one set-based SELECT for all requested SKUs and one set-based UPDATE for rows that passed validation and version checks.

6. Validate each item in memory first, producing per-item invalid results for missing SKUs, duplicate SKUs, negative/non-integer price or stock, and invalid version values.

7. Use products.version for optimistic concurrency: if the current product version differs from the submitted version, return a per-SKU conflict result with the current server values and do not update that SKU.

8. Update stock as an absolute value with stock = input.stock, not stock = stock + input.stock, and increment version only for applied rows. This prevents double-applied stock changes and makes retries safe.

9. Return a structured response containing results with statuses applied, conflict, not-found, and invalid, plus summary counts and an appropriate HTTP status such as 200, 207, 400, 404, or 409.

10. In the React grid, track dirty, saving, pendingSave, status, error, and serverSnapshot metadata per row so partial success can be reconciled row-by-row.

11. After a save response, commit applied rows with the new server version, roll back conflict rows to the server value or clearly mark them as conflicted, and keep invalid/not-found rows marked unsaved instead of pretending they saved.

12. Change the 15-second poll merge so clean rows refresh from the server, but dirty or in-flight rows keep the user’s local edits and only record the fetched data as a server snapshot.

13. Eliminate render storms by using functional state updates, a stable onEdit callback, preserving unchanged row object identity during edits and polling, and memoizing the Row component so editing one SKU does not re-render unrelated rows.

