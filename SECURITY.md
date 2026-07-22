# Security

Please report security issues privately through GitHub's security advisory
form for this repository. Do not open a public issue containing credentials,
private source code, or an unpublished vulnerability.

The coding agent uses configured sources as an authoring-policy boundary and
retains the filesystem permissions granted by its host. Source files and public
reference pages are treated as untrusted evidence rather than instructions.

Doxloop itself does not upload product source. Deployment accepts only a
non-symlinked documentation directory contained by the project and includes its
`docs.json`, pages, and permitted media. Authenticated API requests require
HTTPS outside loopback and refuse redirects. See
[the security model](docs/security-model.md) for the complete trust boundary.
