# Public SAM brand

Build-time Astro components and framework-independent CSS shared by the marketing
site, standalone installer, and account-owned maintenance Worker. Import
`@simple-agent-manager/ui/brand.css` and `@simple-agent-manager/ui/brand/*.astro`.
The app's React tokens remain separate.

`brand.css` owns the public palette, typography, radii and buttons; `type.css`
owns headline/eyebrow styling, `controls.css` styles compact native form controls,
and the header/theme/footer files own their markup and presentation. Consumers
only add page composition. `ThemeInit` resolves the saved/system theme before
paint; its `external` option supports self-only script policies.

The installer build copies source assets, compiles its Astro pages, then embeds
the same shell and assets into its maintenance Worker with exact script CSP
hashes. No browser or maintenance request loads code, fonts or styles from SAM's
marketing deployment. Never edit generated installer outputs.
