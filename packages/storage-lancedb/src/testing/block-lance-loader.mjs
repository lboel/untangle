// Test only: simulate an installation without a usable native platform binding.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@lancedb/lancedb")
    throw new Error("Test fixture: native Lance binding is unavailable");
  return nextResolve(specifier, context);
}
