# Payments and fintech expertise

Use when the public product moves, authorizes, records, settles, reconciles, or
reports money or other regulated financial value. Pair with the API-platform,
SaaS, or infrastructure template when appropriate.

## Think like a senior payments documentation lead

Document money movement as an explicit state machine with actors, amounts,
currency, timing, identifiers, irreversible boundaries, and failure recovery.
Separate customer intent, provider processing, ledger or balance effects, bank
or network settlement, and reporting when the product exposes those distinctions.

## Investigate

- supported payment or transfer instruments, regions, currencies, and environments;
- amount representation, rounding, precision, fees, exchange, and balance effects;
- authorization, capture, cancellation, refund, reversal, dispute, and settlement states;
- idempotency, duplicate prevention, concurrency, retry, and timeout behavior;
- synchronous responses versus asynchronous completion and event delivery;
- webhook signatures, event versions, replay, deduplication, ordering, and recovery;
- customer, merchant, account, mandate, payout, invoice, and reconciliation identifiers;
- authentication, permissions, sensitive-data boundaries, logging, and redaction;
- test data, sandbox differences, operational cutoffs, reports, and exception handling.

## Design coverage

Lead with a safe test-environment success path. Explain lifecycle diagrams in
text and visuals only when every state and transition is evidenced. Put amounts,
currency, identifiers, idempotency, error handling, and asynchronous completion
near the first integration—not as late production notes.

Show readers how to recognize accepted, pending, completed, failed, canceled,
refunded, or disputed outcomes supported by the product. Separate customer-facing
status from settlement or ledger status when they differ. Provide reconciliation
and exception workflows only where public evidence supports them.

## Navigation overlay

Insert supported destinations into Concepts, Integration guides, Reference, and
Operations:

```text
Money, currencies, and identifiers
Payment or transfer lifecycle
Idempotency and duplicate prevention
Asynchronous processing and webhooks
Capture, cancellation, refund, and reversal
Disputes and exceptions
Settlement, balances, and reconciliation
Testing and go-live
```

Order lifecycle concepts before task guides that depend on state transitions.

## Never assume

Do not claim PCI, banking, privacy, sanctions, consumer-protection, tax, or other
regulatory compliance from source inspection. Do not invent settlement times,
fund availability, exchange rates, dispute rights, exactly-once processing,
webhook ordering, loss guarantees, or production parity. Never place real
financial or personal data in examples or screenshots.

## Senior quality gate

An integrator must be able to prevent accidental duplicates using supported
mechanisms, represent money correctly, track the evidenced lifecycle, verify
asynchronous notifications, distinguish retryable failure, and reconcile the
observable outcome without relying on optimistic assumptions.
