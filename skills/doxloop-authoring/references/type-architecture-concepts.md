# Architecture-and-concepts playbook

Use when readers need a stable public mental model to make correct integration,
administration, deployment, or operational decisions. Do not expose internals
merely because source makes them visible.

## Choose concepts with consequences

Document a concept only when misunderstanding it changes reader action or
outcome. Explain:

- the problem or decision the concept addresses;
- public components, actors, resources, and trust boundaries;
- relationships, ownership, cardinality, scope, and lifecycle;
- data or control flow and asynchronous boundaries;
- invariants, constraints, failure domains, and observable states;
- alternatives and tradeoffs supported by evidence;
- tasks and reference where the reader applies the model.

Use one term for each concept and align it with public interfaces. Prefer a
small diagram plus equivalent prose when several components or state transitions
interact. Label conceptual diagrams and avoid implying undocumented topology,
scale, or security properties.

## Reader relevance

Adapt the boundary: developers need contract and lifecycle; administrators need
scope and authority; operators need dependencies and failure domains; evaluators
need capability and operating model. Keep internal implementation and repository
structure out unless maintainers are the confirmed readers.

## Standard navigation

Keep concepts under Documentation unless Architecture is a major reader surface:

```text
System overview
Core concepts
  Primary resources
  Relationships and ownership
  Lifecycle
Architecture
  Public components
  Data and control flow
  Asynchronous boundaries
Security model
Behavior and consistency
Deployment models
Design decisions and tradeoffs
Limitations
Glossary
```

Order concepts by dependency. Never mirror source packages or internal service
names unless maintainers are the confirmed readers.

## Senior quality gate

After reading, the intended reader can predict important observable behavior,
choose between supported approaches, and understand the consequence of a
boundary or lifecycle state without memorizing implementation details.
