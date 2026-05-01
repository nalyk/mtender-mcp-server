import { z } from "zod";

export const OcidSchema = z
  .string()
  .regex(/^ocds-[A-Za-z0-9]+(-[A-Za-z0-9]+)+$/, "Must be a valid OCDS OCID");

const Money = z.object({ amount: z.number(), currency: z.string() });
const Period = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const Party = z.object({
  id: z.string().optional(),
  name: z.string(),
  roles: z.array(z.string()).default([]),
  identifier: z.string().optional(),
  address: z.object({ country: z.string().optional(), locality: z.string().optional() }).optional(),
});
export type Party = z.infer<typeof Party>;

export const Item = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  classification: z
    .object({
      scheme: z.string().optional(),
      id: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  quantity: z.number().optional(),
  unit: z.object({ name: z.string().optional(), value: Money.optional() }).optional(),
  relatedLot: z.string().optional(),
});
export type Item = z.infer<typeof Item>;

export const Document = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  documentType: z.string().optional(),
  url: z.string().optional(),
  datePublished: z.string().optional(),
  format: z.string().optional(),
});
export type Document = z.infer<typeof Document>;

export const Amendment = z.object({
  id: z.string().optional(),
  date: z.string().optional(),
  rationale: z.string().optional(),
  description: z.string().optional(),
});
export type Amendment = z.infer<typeof Amendment>;

export const Award = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  date: z.string().optional(),
  value: Money.optional(),
  suppliers: z.array(z.object({ id: z.string().optional(), name: z.string() })).default([]),
  relatedLots: z.array(z.string()).default([]),
  documents: z
    .array(z.object({ id: z.string().optional(), title: z.string().optional(), url: z.string().optional() }))
    .default([]),
});
export type Award = z.infer<typeof Award>;

export const Contract = z.object({
  id: z.string().optional(),
  awardID: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
  value: Money.optional(),
  dateSigned: z.string().optional(),
  period: Period.optional(),
  documents: z
    .array(z.object({ id: z.string().optional(), title: z.string().optional(), url: z.string().optional() }))
    .default([]),
});
export type Contract = z.infer<typeof Contract>;

export const RelatedProcess = z.object({
  id: z.string(),
  relationship: z.array(z.string()).default([]),
  identifier: z.string().optional(),
  uri: z.string().optional(),
});

export const Lot = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  statusDetails: z.string().optional(),
  value: Money.optional(),
  contractPeriod: Period.optional(),
  placeOfPerformance: z
    .object({ address: z.object({ countryName: z.string().optional(), locality: z.string().optional() }).optional() })
    .optional(),
});
export type Lot = z.infer<typeof Lot>;

export const Enquiry = z.object({
  id: z.string(),
  date: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  answer: z.string().optional(),
  dateAnswered: z.string().optional(),
});
export type Enquiry = z.infer<typeof Enquiry>;

export const BidStatistic = z.object({
  id: z.string().optional(),
  measure: z.string().optional(),
  value: z.number().optional(),
  date: z.string().optional(),
  notes: z.string().optional(),
  relatedLot: z.string().optional(),
});
export type BidStatistic = z.infer<typeof BidStatistic>;

export const TenderSummary = z.object({
  ocid: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  statusDetails: z.string().optional(),
  procurementMethod: z.string().optional(),
  procurementMethodDetails: z.string().optional(),
  mainProcurementCategory: z.string().optional(),
  value: Money.optional(),
  minValue: Money.optional(),
  tenderPeriod: Period.optional(),
  enquiryPeriod: Period.optional(),
  buyer: z.string().optional(),
  parties: z.array(Party).default([]),
  items: z.array(Item).default([]),
  documents: z.array(Document).default([]),
  amendments: z.array(Amendment).default([]),
  awards: z.array(Award).default([]),
  contracts: z.array(Contract).default([]),
  relatedProcesses: z.array(RelatedProcess).default([]),
  lots: z.array(Lot).default([]),
  enquiries: z.array(Enquiry).default([]),
  bidStatistics: z.array(BidStatistic).default([]),
  procurementMethodModalities: z.array(z.string()).default([]),
  hasElectronicAuction: z.boolean().default(false),
});
export type TenderSummary = z.infer<typeof TenderSummary>;

export const BudgetSummary = z.object({
  ocid: z.string(),
  budgetId: z.string().optional(),
  description: z.string().optional(),
  amount: Money.optional(),
  project: z.string().optional(),
  projectID: z.string().optional(),
  period: Period.optional(),
});
export type BudgetSummary = z.infer<typeof BudgetSummary>;

export const FundingSummary = z.object({
  ocid: z.string(),
  fundingSourceId: z.string(),
  amount: Money.optional(),
  description: z.string().optional(),
  period: Period.optional(),
  parties: z
    .array(z.object({ name: z.string(), roles: z.array(z.string()).default([]) }))
    .default([]),
});
export type FundingSummary = z.infer<typeof FundingSummary>;

export const TenderListItem = z.object({ ocid: z.string(), date: z.string() });
export type TenderListItem = z.infer<typeof TenderListItem>;

export const ReleaseHistoryItem = z.object({
  releaseId: z.string(),
  date: z.string(),
  tag: z.array(z.string()).default([]),
  uri: z.string().optional(),
});
export type ReleaseHistoryItem = z.infer<typeof ReleaseHistoryItem>;

export const BuyerAggRow = z.object({
  buyer: z.string(),
  tenders: z.number(),
  totalValue: z.number(),
  currency: z.string(),
});
export type BuyerAggRow = z.infer<typeof BuyerAggRow>;

export const SupplierAggRow = z.object({
  supplier: z.string(),
  awards: z.number(),
  totalValue: z.number(),
  currency: z.string(),
  ocids: z.array(z.string()),
});
export type SupplierAggRow = z.infer<typeof SupplierAggRow>;
