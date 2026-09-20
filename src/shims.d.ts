// Minimal ambient types so the package typechecks without a hard `next`
// dependency. Consumers with `next` installed get its real types.
declare module "next/cache" {
	export function unstable_cache<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => Promise<TResult>,
		keys?: string[],
		options?: { revalidate?: number | false; tags?: string[] },
	): (...args: TArgs) => Promise<TResult>;
}
