# E-commerce expertise

Use when the product manages catalog, pricing, carts, checkout, orders,
inventory, fulfillment, returns, or commerce integrations.

## Think like a senior commerce documentation lead

Model the customer journey and the operational order lifecycle separately, then
show where they meet. Make scope explicit across store, channel, market,
location, customer, and order. Treat price, availability, payment, tax,
fulfillment, and returns as related but independently verified concerns.

## Investigate

- products, variants, collections, attributes, media, publication, and identifiers;
- price lists, currencies, discounts, promotions, tax inputs, and rounding;
- inventory source, reservation, allocation, availability, and oversell behavior;
- cart and checkout lifecycle, customer identity, address, shipping, and payment handoff;
- order states, edits, cancellation, fulfillment, tracking, return, exchange, and refund;
- channels, stores, locales, markets, warehouses, and configuration scope;
- import/export, synchronization, events, webhooks, and external system ownership;
- permissions, personally identifiable data, retention, and safe test fixtures.

## Design coverage

Use lifecycle-oriented concepts for catalog publication and orders. Give
merchants and operators task guides for daily work; give integrators contract
guidance for synchronization, identifiers, state mapping, and recovery. State
which system is authoritative for each shared object when evidence establishes it.

Use realistic but fictional products, customers, addresses, and amounts. Explain
how readers verify availability, totals, order state, and fulfillment outcomes.

## Navigation overlay

Insert supported destinations by the commerce lifecycle:

```text
Catalog and publication
Pricing, discounts, and tax inputs
Inventory and availability
Cart and checkout
Orders and order changes
Fulfillment and tracking
Returns, exchanges, and refunds
Channels, markets, and integrations
```

Keep merchant operations separate from customer tasks and integration contracts.

## Never assume

Do not invent tax calculation, discount stacking, inventory consistency,
reservation duration, payment behavior, return eligibility, refund timing,
shipping promises, marketplace ownership, or privacy compliance. A visible UI
label does not prove the underlying accounting or fulfillment semantics.

## Senior quality gate

Readers must be able to predict how a supported catalog change becomes visible,
how an order moves through evidenced states, which actor owns each operational
step, and how to diagnose mismatches without creating duplicate orders or
incorrect inventory.
