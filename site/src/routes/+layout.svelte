<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import BookOpen from '@lucide/svelte/icons/book-open';
	import BrandMark from '#lib/components/BrandMark.svelte';
	import History from '@lucide/svelte/icons/history';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	import CodeCopy from '#lib/components/CodeCopy.svelte';
	import GitHubMark from '#lib/components/GitHubMark.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import { currentFor, NAV, SITE } from '#lib/site.js';

	let { children } = $props();

	const ICONS = { Docs: BookOpen, Commands: SquareTerminal, Changelog: History } as const;
	const nav = NAV.map((item) => ({ ...item, icon: ICONS[item.label as keyof typeof ICONS] }));
</script>

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2"
>
	Skip to content
</a>

<header class="sticky top-0 z-40 border-b border-rule bg-bg/95 backdrop-blur" style="height: var(--header-height)">
	<div class="mx-auto flex h-full max-w-6xl items-center justify-between gap-4 px-4">
		<div class="flex items-center gap-1">
			<a
				href={SITE.author.url}
				title={SITE.author.site}
				class="inline-flex size-10 items-center justify-center rounded-md text-ink hover:bg-bg-elevated"
			>
				<BrandMark class="size-6" />
				<span class="sr-only">{SITE.author.site}</span>
			</a>
			<span class="h-6 w-px bg-rule-strong" aria-hidden="true"></span>
			<a href="/" class="px-2 font-mono text-lg font-semibold text-ink">{SITE.name}</a>
		</div>
		<nav aria-label="Main" class="flex items-center gap-1 text-sm">
			{#each nav as item (item.href)}
				<a
					href={item.href}
					title={item.label}
					class="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-md px-2 text-ink-muted hover:bg-bg-elevated hover:text-ink aria-[current]:text-ink"
					aria-current={currentFor(page.url.pathname, item.href)}
				>
					<item.icon size={18} aria-hidden="true" />
					<span class="sr-only sm:not-sr-only">{item.label}</span>
				</a>
			{/each}
			<a
				href={SITE.repo}
				title="Source on GitHub"
				class="inline-flex size-10 items-center justify-center rounded-md text-ink-muted hover:bg-bg-elevated hover:text-ink"
			>
				<GitHubMark />
				<span class="sr-only">Source on GitHub</span>
			</a>
			<ThemeToggle />
		</nav>
	</div>
</header>

<main id="main" tabindex="-1" class="mx-auto max-w-6xl px-4 py-10">
	{@render children()}
</main>
<CodeCopy />

<footer class="border-t border-rule">
	<div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-6 text-sm text-ink-subtle">
		<p>MIT licensed. Made by <a href={SITE.author.url} class="underline hover:text-ink">{SITE.author.name}</a>.</p>
		<ul class="flex gap-4">
			<li><a href={SITE.author.url + '/imprint'} class="inline-flex min-h-6 items-center underline hover:text-ink">Imprint</a></li>
			<li><a href={SITE.author.url + '/privacy'} class="inline-flex min-h-6 items-center underline hover:text-ink">Privacy</a></li>
		</ul>
	</div>
</footer>
