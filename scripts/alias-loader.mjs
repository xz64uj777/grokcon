export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const file = rel.endsWith(".ts") || rel.endsWith(".mjs") || rel.endsWith(".js") ? rel : `${rel}.ts`;
    const url = new URL(`../src/${file}`, import.meta.url);
    return nextResolve(url.href, context);
  }
  return nextResolve(specifier, context);
}
