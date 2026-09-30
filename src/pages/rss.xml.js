import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

export async function GET(context) {
	const posts = (
		await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft)
	).sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		// Cloudflare Pages exposes the deployment URL during its static build.
		// A future configured site takes priority; local builds use their request origin.
		site: context.site ?? process.env.CF_PAGES_URL ?? context.url.origin,
		items: posts.map((post) => ({
			...post.data,
			link: `/blog/${post.data.slug}/`,
		})),
	});
}
