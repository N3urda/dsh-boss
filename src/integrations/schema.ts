import { z } from 'zod';

export const searchSchema = z.strictObject({
  query: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(50),
  page: z.number().int().min(1).max(10).default(1),
});
export const jobSchema = z.strictObject({ jobId: z.string().min(1).max(256) });
export const importSchema = jobSchema.extend({ requestId: z.string().min(1).max(128) });
export const geocodeSchema = z.strictObject({
  recordId: z.string().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
});
export const pointSchema = z.strictObject({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-85).max(85),
});
export const locationSchema = geocodeSchema.extend({
  requestId: z.string().min(1).max(128),
  point: pointSchema,
  precision: z.enum(['building', 'area']),
  label: z.string().trim().min(1).max(1000),
  // The owner confirms a WGS84 point; AI cannot invoke this write.
});
export interface PlaceCandidate {
  id: string;
  label: string;
  point: z.infer<typeof pointSchema>;
  precision: 'building' | 'area';
  provider: 'photon';
  crs: 'WGS84';
  sourceUrl: string;
}
export interface Job {
  jobId: string;
  company: string;
  title: string;
  salary: string;
  city: string;
  district: string;
  experience: string;
  education: string;
  description: string;
  address: string;
  sourceUrl: string;
  fetchedAt: string;
  detail: boolean;
  savedRecordId?: string;
  detailFetchedAt?: string;
}
export interface SearchPage {
  query: string;
  city: string;
  page: number;
  jobs: Job[];
  hasMore: boolean | null;
  fetchedAt: string;
}
