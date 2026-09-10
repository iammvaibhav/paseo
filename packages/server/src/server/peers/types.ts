import { z } from "zod";

export const PeerConfigSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().min(1),
    password: z.string().optional(),
  })
  .strict();
export type PeerConfig = z.infer<typeof PeerConfigSchema>;
