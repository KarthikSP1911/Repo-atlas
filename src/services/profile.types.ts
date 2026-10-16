import { z } from 'zod';

/** Who is asking, in the terms the snapshot uses. Built by `profile_contributor`, consumed by Part B tools. */
export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type Level = (typeof LEVELS)[number];
export const LevelSchema = z.enum(LEVELS).describe('Experience with this kind of codebase: beginner (under about a year), intermediate, or advanced');

export const ProfileSchema = z.object({
  /** Snapshot language ids, lowercase: ts, js, py, go, rust, java, ... (the same ids as file meta `lang`). */
  languages: z.array(z.string().min(1).max(30)).max(12).describe('Languages the contributor knows, as ids like ts, js, py, go, rust, java'),
  level: LevelSchema,
  /** Areas of a repo the contributor is comfortable in, e.g. api, tests, docs, ui, database, cli. */
  familiarAreas: z.array(z.string().max(40)).max(12).default([]).describe('Areas they are comfortable in, e.g. api, tests, docs, ui, database, cli'),
  username: z.string().max(60).optional().describe('Public GitHub username, only if the person gave it'),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** What profile_contributor returns: the profile plus how it was built. */
export interface ProfileResult {
  profile: Profile;
  /** What was read to build it, e.g. "stated by you" or "public GitHub languages for @name (1 call)". */
  readNotes: string[];
  githubCalls: number;
}
