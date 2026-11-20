export const demonstrationPolicy = {
  id: "coldcover-demo-policy",
  name: "ColdCover Demonstration Policy — Deterioration of Stock (Potatoes)",
  label: "Demonstration policy — not an insurer's actual wording.",
  wording: "This fictional policy covers specified deterioration of potatoes held in chamber CH-1 caused by refrigeration breakdown, subject to machinery breakdown cover being in force and the insured maintaining records of stored goods and their recorded values.",
  reviewNote: "Incident evidence and stock condition must be reviewed by a human assessor. A temperature excursion or an inventory value alone does not establish deterioration or entitlement to payment.",
  requiredRecords: [
    "Temperature log covering the incident",
    "Maintenance or refrigeration breakdown report",
    "Stock inspection report",
    "Batch quantities and recorded inventory values",
  ],
  references: "The structure is inspired by publicly available deterioration-of-stock product overviews and policy wordings, such as HDFC ERGO's. This project's text is original demonstration wording; it does not reproduce or represent an insurer's contract.",
} as const;
