# Application branding discovery

Use this reference when creating documentation or when the application's visual
identity changes.

## Find brand evidence

Inspect only configured product sources. Prefer evidence in this order:

1. design-token or theme configuration files;
2. CSS custom properties and global styles;
3. Tailwind, Material UI, Chakra, theme-provider, or equivalent configuration;
4. font declarations and imports;
5. public logo, favicon, and wordmark assets;
6. application manifests and reader-visible metadata.

Capture, when supported by evidence:

- primary, light-theme, and dark-theme accent colors;
- body, heading, and monospace font families;
- light and dark logos, favicon, and logo destination;
- default color mode and whether system mode is supported;
- light and dark page backgrounds.

Record the source file supporting each value. Do not derive exact colors from a
raster image or guess which of several product themes is primary. If evidence is
ambiguous, show the candidates and ask the user which identity the
documentation should use.

## Apply the identity safely

- Keep product identity and reference-site presentation separate. A configured
  design reference may guide typography, color roles, spacing, layout, and
  component geometry, but it does not authorize reuse of another product's
  marks or distinctive assets.
- Use the selected generator's native theme configuration.
- Preserve documentation readability and accessible contrast. Brand fidelity
  does not require copying application layouts or low-contrast UI states.
- Copy only reader-visible public assets into the documentation project.
- Keep copied asset names stable and record their source.
- Copy local font files only when their repository license and existing public
  use permit redistribution. Otherwise use the documented font family with a
  safe fallback and report that the preview may substitute it.
- Never copy secrets, internal design files, source maps, or assets outside the
  configured sources.
- Do not hotlink a local path outside the documentation project.

Include the captured identity and evidence in the discovery summary. Apply it
after the user confirms the documentation plan, then verify both light and dark
rendering when the application supports both.
