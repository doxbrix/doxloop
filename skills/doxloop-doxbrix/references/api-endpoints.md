# Doxbrix API endpoint reference

Use this contract for every HTTP operation documented in a Doxbrix project.
The native reader turns this structure into the method/path bar, Try it action,
grouped parameters, generated request example, and response tabs.

- [Page contract](#page-contract)
- [Canonical syntax](#canonical-syntax)
- [Verification](#verification)

## Page contract

- Prefer one endpoint page and one `<ApiEndpoint>` block per operation.
- Use the page title for the operation name, such as `List projects`.
- Open with one short sentence describing the observable behavior.
- Put `method`, `path`, `baseUrl`, `summary`, and `description` on
  `<ApiEndpoint>`.
- Add one `<Param>` for every verified path, query, header, or body parameter.
- Add one `<Response>` for the successful status and each important verified
  error status.
- Keep example values realistic but visibly non-secret.
- Use raw JSON inside `<Response>` without an additional fenced code block.
- Get every name, type, required flag, default, limit, status, and example shape
  from OpenAPI, public schemas, route contracts, or tests. Invent nothing.

## Canonical syntax

```mdx
---
title: List projects
description: List the projects available to the current API key.
---

Lists the projects in your workspace that the API key can access.
Results use cursor pagination.

<ApiEndpoint
  method="GET"
  path="/projects"
  baseUrl="https://api.example.com/v1"
  summary="List projects"
  description="Returns a page of projects."
>
<Param
  name="Authorization"
  in="header"
  type="string"
  required
  example="Bearer api_test_example"
>
Bearer token sent in the `Authorization` header.
</Param>
<Param
  name="limit"
  in="query"
  type="integer"
  example="50"
>
Maximum results per page. Defaults to 50; maximum 100.
</Param>
<Param
  name="cursor"
  in="query"
  type="string"
  example="next_page_cursor"
>
Pagination cursor returned by the previous response.
</Param>
<Response
  status={200}
  contentType="application/json"
  description="Projects listed"
>
{
  "data": [
    {
      "id": "prj_01H9",
      "name": "Acme Docs"
    }
  ],
  "nextCursor": null
}
</Response>
<Response
  status={401}
  contentType="application/json"
  description="Authentication failed"
>
{
  "error": {
    "code": "unauthorized",
    "message": "Provide a valid API key."
  }
}
</Response>
</ApiEndpoint>
```

Use only supported values:

- `method`: `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`;
- `in`: `path`, `query`, `header`, or `body`;
- `required`: prefer a bare boolean attribute when true; `{true}` is also
  accepted; omit it when false;
- `status`: a numeric expression such as `{200}`;
- `contentType`: normally `application/json`, when verified.

For every `{placeholder}` in `path`, add a matching required path parameter:

```mdx
<Param name="projectId" in="path" type="string" required example="prj_01H9">
Project identifier.
</Param>
```

Do not use a Markdown parameter table, a prose-only endpoint, or separate cURL
and response fences in place of `<ApiEndpoint>`. The reader generates the
request presentation from the block attributes and parameter examples.

## Verification

Run `doxloop test`, then inspect the page in `doxloop preview --open`. Confirm:

- the method and path appear in the endpoint bar;
- header, path, and query parameters appear in their proper sections;
- required and type badges are correct;
- the request example uses the verified base URL and parameter examples;
- success and error statuses appear as response tabs with valid example bodies.
