# AI and machine-learning expertise

Use when readers configure, train, evaluate, deploy, or consume models, agents,
embeddings, classifiers, generators, or other probabilistic systems.

## Think like a senior AI product documentation lead

Separate interface contract from probabilistic behavior. Document inputs,
outputs, controls, limits, evaluation, observability, and human oversight. Make
variability and failure visible without turning the guide into a research paper.

## Investigate

- model or capability identifiers, versions, availability, and lifecycle;
- accepted input modalities, formats, sizes, preprocessing, and encoding;
- output schema, streaming, termination, structured output, and validation;
- configurable sampling, tools, retrieval, memory, context, and safety controls;
- latency, quotas, token or usage accounting, batching, and concurrency when public;
- determinism limits, seed behavior, confidence, abstention, and error handling;
- evaluation fixtures, quality metrics, regression tests, and monitoring signals;
- data handling, retention, training use, access controls, and deletion commitments;
- prompt injection, unsafe content, tool authority, and human approval boundaries;
- fallback, model migration, deprecation, and reproducibility evidence.

## Design coverage

Give readers a verified baseline example and an evaluation loop. Explain how to
validate outputs before downstream use, bound tool permissions, handle malformed
or unsafe results, monitor quality drift, and choose evidenced controls. Label
sample output as illustrative when exact reproduction is not guaranteed.

Keep model concepts connected to decisions: quality, latency, cost, context,
safety, and operational complexity. Document structured schemas and observable
errors precisely; describe subjective quality with evaluation methods rather
than unsupported adjectives.

## Navigation overlay

Insert supported destinations into Getting started, Concepts, Guides, Reference,
and Operations:

```text
Models and capabilities
Inputs, prompting, and context
Tools, retrieval, and structured output
Evaluation and quality
Safety and human oversight
Limits, latency, and usage
Monitoring and fallback
Model versions and migration
```

Put evaluation and output validation near the first real workflow, not only in
advanced operations.

## Never assume

Do not claim accuracy, fairness, safety, determinism, privacy, data residency,
training-data exclusion, model identity, context size, retention, or regulatory
fitness without authoritative evidence. Never present generated output as a
guaranteed response or recommend unreviewed automation for consequential actions.

## Senior quality gate

A reader must be able to run the supported capability, validate its output,
understand material variability and limits, constrain authority, evaluate changes,
and operate a safe fallback for evidenced failure modes.
