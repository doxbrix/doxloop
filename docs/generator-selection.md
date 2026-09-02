# Select a documentation generator

Choose the generator in the setup wizard's **Tools** step, under
**Documentation generator**. Doxbrix is built in and recommended; choosing
another generator installs its adapter package into the new documentation
project before the workspace opens.

Use Doxbrix for native Doxbrix publishing and interactive API endpoint blocks.
Choose another generator when an existing toolchain, extension ecosystem, or
static-hosting requirement is more important. Native generators may also need
their own runtime, such as Python for MkDocs and Sphinx, Ruby for Jekyll, or
the Hugo binary.

The active generator is shown under **Settings → Generator**. It is
deliberately read-only there: navigation, frontmatter, components, themes, and
route rules are not mechanically equivalent between generators, so Doxloop has
no in-place conversion.

To migrate:

1. Open the control center from the folder where the new documentation project
   should live and choose **New documentation project** with the target
   generator.
2. Connect the same sources and enter the same documentation brief.
3. In the guidance step, ask the planner to preserve the agreed coverage while
   translating content into the target generator's native format.
4. Review the proposal, comparing routes, navigation, metadata, components,
   and theme behaviour with the existing site.
5. Use **Preview docs** and a **Dry run** on the Deploy page, which runs the
   target generator's strict build.
6. Redirect changed public URLs before replacing the existing site.

Keep the original project until the new site passes validation and route review.
