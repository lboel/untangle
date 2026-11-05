import * as z from "zod/v4";

/** Repository-relative roots are selectors, never filesystem escape paths. */
const rootSelector = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      (!value.startsWith("/") &&
          !/[:\\*?[\]{}]/u.test(value) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
        !Array.from(value).some((character) => character.charCodeAt(0) < 32)),
    "Expected a literal repository-relative directory (empty string selects the repository root).",
  );

const origin = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) origin without credentials, path, query or fragment.");

export const httpServiceBindingSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    frontendRoots: z.array(rootSelector).min(1).max(32),
    backendRoots: z.array(rootSelector).min(1).max(32),
    sameOrigin: z.boolean().optional(),
    origins: z.array(origin).max(32).optional(),
  })
  .strict();

export const httpServiceBindingsSchema = z
  .array(httpServiceBindingSchema)
  .max(100)
  .superRefine((services, ctx) => {
    const ids = new Set<string>();
    services.forEach((service, i) => {
      if (ids.has(service.id))
        ctx.addIssue({ code: "custom", path: [i, "id"], message: "Service ids must be unique." });
      ids.add(service.id);
    });
  });

export const httpServicesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    services: httpServiceBindingsSchema,
  })
  .strict();
