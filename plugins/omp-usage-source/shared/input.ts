import { z } from "zod";

/** One OMP login: the OMP provider id and the identity OMP reports for it. */
export const inputSchema = z
  .object({
    provider: z.string().min(1),
    identity: z.string().min(1),
  })
  .strict();
export type OmpUsageInput = z.infer<typeof inputSchema>;
