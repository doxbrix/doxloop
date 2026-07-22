# Select a documentation generator

Choose the generator when initializing a project. Doxbrix is built in; external
generators require their package in the new project.

Use Doxbrix for native Doxbrix publishing and interactive API endpoint blocks.
Choose another generator when an existing toolchain, extension ecosystem, or
static-hosting requirement is more important.

`doxloop generator add <name>` installs support; it does not rewrite the project
or convert existing content. Doxloop currently has no automatic generator
migration because navigation, frontmatter, components, themes, and route rules
are not mechanically equivalent.

To migrate:

1. Create a new project with the target generator.
2. Copy the confirmed documentation brief and source bindings.
3. Ask `doxloop create` to preserve the agreed coverage while translating
   content into the target generator's native format.
4. Compare routes, navigation, metadata, components, and theme behavior.
5. Run `doxloop test` and the target generator's strict build.
6. Redirect changed public URLs before replacing the existing site.

Keep the original project until the new site passes validation and route review.
