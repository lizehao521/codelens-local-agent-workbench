/** Artifact endpoints validation (P1-6). */

import { z } from 'zod';

export const ArtifactSessionParamSchema = z.object({
  sessionId: z.string().uuid(),
});

export const ArtifactIdParamSchema = z.object({
  sessionId: z.string().uuid(),
  id: z.string().min(1).max(128),
});
