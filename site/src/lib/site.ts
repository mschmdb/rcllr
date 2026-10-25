// Facts about the site that several pages share.

export const SITE = {
  name: "rcllr",
  url: "https://rcllr.schmidbauer.dev",
  repo: "https://github.com/mschmdb/rcllr",
  npm: "https://www.npmjs.com/package/rcllr",
  /** Imprint and privacy policy live on the author's site. */
  author: { name: "Matze Schmidbauer", site: "schmidbauer.dev", url: "https://schmidbauer.dev" },
  title: "rcllr: Shared long-term memory for Claude Code and Codex",
  description: "rcllr gives Claude Code and Codex one shared long-term memory: what one agent learns, the other finds. "
    + "Markdown notes in your own Git repo, no server, no database.",
} as const;

/** The share image, made by scripts/og-image.ts. */
export const OG_IMAGE = {
  url: SITE.url + "/og.png",
  width: 1200,
  height: 630,
  alt: "rcllr: one memory for all your coding agents",
} as const;

/** Top-level navigation. Sections that do not exist yet stay out, so no link leads nowhere. */
export const NAV: readonly { href: string; label: string }[] = [
  { href: "/docs/quickstart-5-minutes", label: "Docs" },
  { href: "/commands", label: "Commands" },
  { href: "/changelog", label: "Changelog" },
];

/** The first path segment, e.g. `/docs/agent-setup` to `docs`. */
function section(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

/** `aria-current` for a navigation link: `page` on the page itself, `true` anywhere else in its section. */
export function currentFor(pathname: string, href: string): "page" | "true" | undefined {
  if (pathname === href) return "page";
  const own = section(href);
  return own !== "" && section(pathname) === own ? "true" : undefined;
}
