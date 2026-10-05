import { z } from "zod";

/** One OMP Grok Build login, found again by its listed identity on every fetch. */
export const inputSchema = z
  .object({
    identity: z.string().min(1),
  })
  .strict();
export type GrokBuildUsageInput = z.infer<typeof inputSchema>;
